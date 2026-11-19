// Copies the website files into www/ (the folder packed into the Android app)
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const out = path.join(root, 'www');
const items = ['index.html', 'app.js', 'projects.js', 'manifest.webmanifest', 'lib', 'icons'];
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out);
for (const it of items) {
  fs.cpSync(path.join(root, it), path.join(out, it), { recursive: true });
}
// Stamp the build date into the app (shown in Settings as "עודכן לאחרונה")
const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' }));
const stamp = String(now.getDate()).padStart(2, '0') + '/' + String(now.getMonth() + 1).padStart(2, '0') + '/' + now.getFullYear();
const appPath = path.join(out, 'app.js');
fs.writeFileSync(appPath, fs.readFileSync(appPath, 'utf8').replace(/var APP_UPDATED = '[^']*'/, "var APP_UPDATED = '" + stamp + "'"));
console.log('build date:', stamp);
console.log('www ready:', fs.readdirSync(out).join(', '));
