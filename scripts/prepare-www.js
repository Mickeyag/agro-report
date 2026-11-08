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
console.log('www ready:', fs.readdirSync(out).join(', '));
