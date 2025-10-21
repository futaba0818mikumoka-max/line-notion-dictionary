const { Client } = require('@notionhq/client');

const notion = new Client({
  auth: 'secret_rvqZbbBEZFbrPkOdLEJpigbGc6LWp4qL34Ynh5OL58D'
});

notion.databases.retrieve({
  database_id: '29240f84eb51809db696da56cd07ccf1'
}).then(db => {
  console.log('Database Title:', db.title[0]?.plain_text);
  console.log('Properties:');
  Object.entries(db.properties).forEach(([key, prop]) => {
    console.log(`  ${key}: ${prop.type}`);
  });
}).catch(err => {
  console.error('Error:', err.message);
});