const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const USER_DATA = 'C:\\Users\\yasin\\AppData\\Local\\Temp\\chrome_dash_prof';
const TEMP_DIR = 'C:\\Users\\yasin\\AppData\\Local\\Temp';
const ARTIFACT_DIR = 'C:\\Users\\yasin\\.gemini\\antigravity\\brain\\807e5188-f12c-4499-92dd-77e12018a27f';
const DASH_SCREENSHOT_DIR = fs.existsSync(path.resolve(__dirname, '../frontend/admin-dashboard/screenshots'))
  ? path.resolve(__dirname, '../frontend/admin-dashboard/screenshots')
  : path.resolve(__dirname, '../admin-dashboard/screenshots');

if (!fs.existsSync(DASH_SCREENSHOT_DIR)) {
  fs.mkdirSync(DASH_SCREENSHOT_DIR, { recursive: true });
}

const views = [
  { name: '01_login_screen', url: 'file:///C:/Users/yasin/Desktop/git/coustomer_support_chatbot/admin-dashboard/index.html?login=true' },
  { name: '02_overview_dashboard', url: 'file:///C:/Users/yasin/Desktop/git/coustomer_support_chatbot/admin-dashboard/index.html?view=overview' },
  { name: '03_conversations_management', url: 'file:///C:/Users/yasin/Desktop/git/coustomer_support_chatbot/admin-dashboard/index.html?view=conversations' },
  { name: '04_whatsapp_support_tickets', url: 'file:///C:/Users/yasin/Desktop/git/coustomer_support_chatbot/admin-dashboard/index.html?view=tickets' },
  { name: '05_ai_monitoring', url: 'file:///C:/Users/yasin/Desktop/git/coustomer_support_chatbot/admin-dashboard/index.html?view=ai-monitoring' },
  { name: '06_knowledge_base', url: 'file:///C:/Users/yasin/Desktop/git/coustomer_support_chatbot/admin-dashboard/index.html?view=knowledge-base' },
  { name: '07_store_policies', url: 'file:///C:/Users/yasin/Desktop/git/coustomer_support_chatbot/admin-dashboard/index.html?view=store-policies' },
  { name: '08_support_analytics', url: 'file:///C:/Users/yasin/Desktop/git/coustomer_support_chatbot/admin-dashboard/index.html?view=analytics' },
  { name: '09_team_management', url: 'file:///C:/Users/yasin/Desktop/git/coustomer_support_chatbot/admin-dashboard/index.html?view=agents' },
  { name: '10_system_settings', url: 'file:///C:/Users/yasin/Desktop/git/coustomer_support_chatbot/admin-dashboard/index.html?view=settings' },
];

console.log('📸 Generating Headless Chrome Screenshots for Phase 8 Admin Dashboard Cockpit...\n');

for (const v of views) {
  const tempFile = path.join(TEMP_DIR, `${v.name}.png`);
  const artifactFile = path.join(ARTIFACT_DIR, `${v.name}.png`);
  const dashFile = path.join(DASH_SCREENSHOT_DIR, `${v.name}.png`);

  if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);

  const args = [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    `--user-data-dir=${USER_DATA}`,
    '--window-size=1440,900',
    '--virtual-time-budget=3000',
    `--screenshot=${tempFile}`,
    v.url,
  ];

  const res = spawnSync(CHROME, args, { encoding: 'utf8' });

  if (fs.existsSync(tempFile)) {
    fs.copyFileSync(tempFile, artifactFile);
    fs.copyFileSync(tempFile, dashFile);
    const sz = fs.statSync(dashFile).size;
    console.log(`✅ [${v.name}.png] generated successfully (${(sz / 1024).toFixed(1)} KB)`);
  } else {
    console.error(`❌ [${v.name}.png] failed. Status: ${res.status}`);
  }
}

console.log('\n✨ All screenshots captured and saved to both artifact and dashboard directories.');
