AGRO REPORT — דוח פיקוח (אתר + אפליקציית אנדרואיד)
====================================================

כתובת האתר:      https://mickeyag.github.io/agro-report/
הורדת האפליקציה:  https://github.com/Mickeyag/agro-report/releases/latest/download/agro-report.apk

מה יש בתיקייה
- index.html, app.js, sw.js, manifest.webmanifest, lib/, icons/  — האפליקציה עצמה
- projects.js            — רשימת הפרויקטים והעצים (נוצר מהאקסל — לא לערוך ידנית)
- update_projects.py     — ממיר את האקסל ל-projects.js
- package.json, capacitor.config.json, scripts/, assets/, .github/  — בניית אפליקציית האנדרואיד
- .nojekyll              — קובץ ריק, נדרש ל-GitHub Pages

בניית האפליקציה
כל העלאה ל-GitHub בונה אוטומטית APK חדש (לשונית Actions, כ-5 דקות).
הקובץ מתפרסם ב-Releases ובקישור ההורדה שלמעלה.

עדכון רשימת הפרויקטים
1. מעדכנים את האקסל ומריצים:  python update_projects.py "..\עצים מיוחדים לשימור והעתקה.xlsx"
2. מעלים ל-GitHub את projects.js.
האפליקציה בטלפון מורידה את הרשימה החדשה לבד בפעם הבאה שהיא נפתחת עם אינטרנט — אין צורך להתקין מחדש.

מפתח החתימה (KEYSTORE_BASE64.txt, agro-report.keystore)
- לא להעלות ל-GitHub! לשמור במקום בטוח.
- התוכן של KEYSTORE_BASE64.txt מודבק פעם אחת ב-GitHub:
  Settings > Secrets and variables > Actions > New repository secret, שם: KEYSTORE_BASE64
- בלי המפתח הזה, גרסה חדשה לא תותקן מעל הישנה (יהיה צורך להסיר ולהתקין מחדש, והטיוטה תימחק).
