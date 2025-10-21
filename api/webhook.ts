import dotenv from "dotenv";
dotenv.config();
import { middleware as lineMW, Client as LineClient, WebhookEvent } from "@line/bot-sdk";
import OpenAI from "openai";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { Client as Notion } from "@notionhq/client";

// レート制御と再試行ユーティリティ
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function retry<T>(fn: () => Promise<T>, maxRetries: number = 3, delay: number = 1000): Promise<T> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (error) {
      if (i === maxRetries - 1) throw error;
      console.warn(`Attempt ${i + 1} failed, retrying in ${delay}ms...`, error);
      await sleep(delay);
      delay *= 2; // 指数バックオフ
    }
  }
  throw new Error("Retry failed");
}

const {
  LINE_CHANNEL_SECRET,
  LINE_ACCESS_TOKEN,
  OPENAI_API_KEY,
  NOTION_TOKEN,
  NOTION_DATABASE_ID,
  OPENAI_MODEL = "gpt-4o-mini"
} = process.env;

const lineClient = LINE_ACCESS_TOKEN ? new LineClient({
  channelAccessToken: LINE_ACCESS_TOKEN,
  channelSecret: LINE_CHANNEL_SECRET!,
}) : null;
const notion = NOTION_TOKEN ? new Notion({ auth: NOTION_TOKEN }) : null;

// ====== JSON スキーマ（日本語キー）======
const Schema = z.object({
  単語: z.string(),
  発音記号: z.string().optional(),
  品詞: z.array(z.string()).optional(),
  意味: z.array(z.string()).min(1),
  語源: z.string().optional(),
  コロケーション: z.array(z.string()).optional(),
  例文: z.array(z.object({ 英: z.string(), 日: z.string().optional() })).min(1).max(3).optional(),
  CEFR: z.string().optional(),
  類義語: z.array(z.string()).optional(),
  出典URL: z.string().optional()
});
type Entry = z.infer<typeof Schema>;

// ====== OpenAI（構造化出力）======
async function buildEntry(word: string): Promise<Entry> {
  return retry(async () => {
    const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

    const system = `あなたは日本人学習者向けの英語辞書アシスタントです。
出力は必ず「日本語のキーのみのJSON」で、下記スキーマに完全準拠してください。冗長にしないでください。`;

    const user = `対象語: "${word}"
必要項目: 単語, 発音記号, 品詞, 意味(日本語/複数可), 語源(簡潔), コロケーション(自然なもの優先),
例文 1〜3（{英, 日}）、CEFR, 類義語, 出典URL（あれば）。
返答は日本語キーのJSONのみ。説明文は不要。`;

    const completion = await openai.chat.completions.create({
      model: OPENAI_MODEL!,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user }
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "WordJP",
          schema: zodToJsonSchema(Schema) as any
        }
      }
    });

    const text = completion.choices[0]?.message?.content;
    if (!text) throw new Error("No response from OpenAI");

    return Schema.parse(JSON.parse(text));
  });
}

// ====== Notion へ保存（日本語プロパティ固定マッピング）======
async function saveToNotion(e: Entry) {
  if (!notion) throw new Error("Notion client not initialized");
  return retry(async () => {
    // 1) Page properties
    const props: any = {
      "Vocabulary": { title: [{ text: { content: e.単語 } }] },
      "発音記号": e.発音記号 ? { rich_text: [{ text: { content: e.発音記号 } }] } : undefined,
      "品詞": e.品詞 ? { multi_select: e.品詞.map((v: string) => ({ name: v })) } : undefined,
      "意味": { rich_text: e.意味.map((m: string) => ({ text: { content: `• ${m}` } })) },
      "語源": e.語源 ? { rich_text: [{ text: { content: e.語源 } }] } : undefined,
      "コロケーション": e.コロケーション ? { rich_text: [{ text: { content: e.コロケーション.join(", ") } }] } : undefined,
      "CEFR": e.CEFR ? { select: { name: e.CEFR } } : undefined,
      "類義語": e.類義語 ? { rich_text: [{ text: { content: e.類義語.join(", ") } }] } : undefined,
      "出典URL": e.出典URL ? { url: e.出典URL } : undefined,
    };

    const page = await notion.pages.create({
      parent: { database_id: NOTION_DATABASE_ID! },
      properties: props
    });

    // 2) 本文に例文を追加
    if (e.例文 && e.例文.length) {
      await notion.blocks.children.append({
        block_id: (page as any).id,
        children: e.例文.map((s: { 英: string; 日?: string }) => ({
          type: "bulleted_list_item",
          bulleted_list_item: {
            rich_text: [
              { type: "text", text: { content: s.英 } },
              ...(s.日 ? [{ type: "text", text: { content: `  — ${s.日}` } }] : [])
            ]
          }
        })) as any
      });
    }
  });
}

// ====== LINE Webhook ======
export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const events = req.body.events as WebhookEvent[];
    await Promise.all(events.map(handleEventSafely));
    res.status(200).end();
  } catch (error) {
    console.error('Webhook error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

async function handleEventSafely(event: WebhookEvent) {
  try {
    if (event.type !== "message" || event.message.type !== "text") return;
    const word = event.message.text.trim();
    if (!word) return;

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
  } catch (err) {
    console.error("Error processing event:", err);
    if ("replyToken" in event && lineClient) {
      try {
        await lineClient.replyMessage((event as any).replyToken, {
          type: "text",
          text: "登録中にエラーが発生しました。もう一度お試しください。"
        });
      } catch (replyErr) {
        console.error("Failed to send error reply:", replyErr);
      }
    }
  }
}