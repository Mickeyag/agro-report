// Adds permissions and version number to the generated Android project
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');

const manifestPath = path.join(root, 'android/app/src/main/AndroidManifest.xml');
let m = fs.readFileSync(manifestPath, 'utf8');
const perms = [
  '<uses-permission android:name="android.permission.READ_EXTERNAL_STORAGE" android:maxSdkVersion="32" />',
  '<uses-permission android:name="android.permission.WRITE_EXTERNAL_STORAGE" android:maxSdkVersion="29" />'
];
for (const p of perms) {
  const name = p.match(/android:name="([^"]+)"/)[1];
  if (!m.includes(name)) m = m.replace('</manifest>', '    ' + p + '\n</manifest>');
}
if (!m.includes('requestLegacyExternalStorage')) {
  m = m.replace('<application', '<application android:requestLegacyExternalStorage="true"');
}
fs.writeFileSync(manifestPath, m);

const gradlePath = path.join(root, 'android/app/build.gradle');
let g = fs.readFileSync(gradlePath, 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const code = parseInt(process.env.GITHUB_RUN_NUMBER || '1', 10);
g = g.replace(/versionCode\s+\d+/, 'versionCode ' + code)
     .replace(/versionName\s+"[^"]*"/, 'versionName "' + pkg.version + '.' + code + '"');
fs.writeFileSync(gradlePath, g);
console.log('Android patched: versionCode', code, 'versionName', pkg.version + '.' + code);
