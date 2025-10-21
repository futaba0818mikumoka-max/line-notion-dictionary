"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const bot_sdk_1 = require("@line/bot-sdk");
const openai_1 = __importDefault(require("openai"));
const zod_1 = require("zod");
const client_1 = require("@notionhq/client");
// レート制御と再試行ユーティリティ
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
async function retry(fn, maxRetries = 3, delay = 1000) {
    for (let i = 0; i < maxRetries; i++) {
        try {
            return await fn();
        }
        catch (error) {
            if (i === maxRetries - 1)
                throw error;
            console.warn(`Attempt ${i + 1} failed, retrying in ${delay}ms...`, error);
            await sleep(delay);
            delay *= 2; // 指数バックオフ
        }
    }
    throw new Error("Retry failed");
}
const { LINE_CHANNEL_SECRET, LINE_ACCESS_TOKEN, OPENAI_API_KEY, NOTION_TOKEN, NOTION_DATABASE_ID, OPENAI_MODEL = "gpt-4o-mini" } = process.env;
const app = (0, express_1.default)();
const lineClient = LINE_ACCESS_TOKEN ? new bot_sdk_1.Client({
    channelAccessToken: LINE_ACCESS_TOKEN,
    channelSecret: LINE_CHANNEL_SECRET,
}) : null;
const notion = NOTION_TOKEN ? new client_1.Client({ auth: NOTION_TOKEN }) : null;
// ====== JSON スキーマ（日本語キー）======
const Schema = zod_1.z.object({
    単語: zod_1.z.string(),
    発音記号: zod_1.z.string().optional(),
    品詞: zod_1.z.array(zod_1.z.string()).optional(),
    意味: zod_1.z.array(zod_1.z.string()).min(1),
    語源: zod_1.z.string().optional(),
    コロケーション: zod_1.z.array(zod_1.z.string()).optional(),
    例文: zod_1.z.array(zod_1.z.object({ 英: zod_1.z.string(), 日: zod_1.z.string().optional() })).min(1).max(3).optional(),
    CEFR: zod_1.z.string().optional(),
    類義語: zod_1.z.array(zod_1.z.string()).optional(),
    出典URL: zod_1.z.string().url().optional()
});
// ====== OpenAI（構造化出力）======
async function buildEntry(word) {
    return retry(async () => {
        const openai = new openai_1.default({ apiKey: OPENAI_API_KEY });
        const system = `あなたは日本人学習者向けの英語辞書アシスタントです。
出力は必ず「日本語のキーのみのJSON」で、下記スキーマに完全準拠してください。冗長にしないでください。`;
        const user = `対象語: "${word}"
必要項目: 単語, 発音記号, 品詞, 意味(日本語/複数可), 語源(簡潔), コロケーション(自然なもの優先),
例文 1〜3（{英, 日}）、CEFR, 類義語, 出典URL（あれば）。
返答は日本語キーのJSONのみ。説明文は不要。`;
        const completion = await openai.chat.completions.create({
            model: OPENAI_MODEL,
            messages: [
                { role: "system", content: system },
                { role: "user", content: user }
            ],
            response_format: {
                type: "json_schema",
                json_schema: {
                    name: "WordJP",
                    schema: Schema
                }
            }
        });
        const text = completion.choices[0]?.message?.content;
        if (!text)
            throw new Error("No response from OpenAI");
        return Schema.parse(JSON.parse(text));
    });
}
// ====== Notion へ保存（日本語プロパティ固定マッピング）======
async function saveToNotion(e) {
    if (!notion)
        throw new Error("Notion client not initialized");
    return retry(async () => {
        // 1) Page properties
        const props = {
            "単語": { title: [{ text: { content: e.単語 } }] },
            "発音記号": e.発音記号 ? { rich_text: [{ text: { content: e.発音記号 } }] } : undefined,
            "品詞": e.品詞 ? { multi_select: e.品詞.map((v) => ({ name: v })) } : undefined,
            "意味": { rich_text: e.意味.map((m) => ({ text: { content: `• ${m}` } })) },
            "語源": e.語源 ? { rich_text: [{ text: { content: e.語源 } }] } : undefined,
            "コロケーション": e.コロケーション ? { rich_text: [{ text: { content: e.コロケーション.join(", ") } }] } : undefined,
            "CEFR": e.CEFR ? { select: { name: e.CEFR } } : undefined,
            "類義語": e.類義語 ? { rich_text: [{ text: { content: e.類義語.join(", ") } }] } : undefined,
            "出典URL": e.出典URL ? { url: e.出典URL } : undefined,
        };
        const page = await notion.pages.create({
            parent: { database_id: NOTION_DATABASE_ID },
            properties: props
        });
        // 2) 本文に例文を追加
        if (e.例文 && e.例文.length) {
            await notion.blocks.children.append({
                block_id: page.id,
                children: e.例文.map((s) => ({
                    type: "bulleted_list_item",
                    bulleted_list_item: {
                        rich_text: [
                            { type: "text", text: { content: s.英 } },
                            ...(s.日 ? [{ type: "text", text: { content: `  — ${s.日}` } }] : [])
                        ]
                    }
                }))
            });
        }
    });
}
// ====== LINE Webhook ======
app.post("/webhook", LINE_CHANNEL_SECRET ? (0, bot_sdk_1.middleware)({ channelAccessToken: LINE_ACCESS_TOKEN, channelSecret: LINE_CHANNEL_SECRET }) : (req, res, next) => next(), async (req, res) => {
    const events = req.body.events;
    await Promise.all(events.map(handleEventSafely));
    res.status(200).end();
});
async function handleEventSafely(event) {
    try {
        if (event.type !== "message" || event.message.type !== "text")
            return;
        const word = event.message.text.trim();
        if (!word)
            return;
        console.log(`Processing word: ${word}`);
        const entry = await buildEntry(word);
        console.log(`Built entry for: ${entry.単語}`);
        await saveToNotion(entry);
        console.log(`Saved to Notion: ${entry.単語}`);
        if (lineClient) {
            await lineClient.replyMessage(event.replyToken, {
                type: "text",
                text: `「${entry.単語}」をNotionに追加しました ✅`
            });
        }
    }
    catch (err) {
        console.error("Error processing event:", err);
        if ("replyToken" in event && lineClient) {
            try {
                await lineClient.replyMessage(event.replyToken, {
                    type: "text",
                    text: "登録中にエラーが発生しました。もう一度お試しください。"
                });
            }
            catch (replyErr) {
                console.error("Failed to send error reply:", replyErr);
            }
        }
    }
}
app.listen(process.env.PORT ?? 3000, () => console.log("Server started"));
