# קריאת שירות בווידאו — POC

אפליקציה וובית לפתיחת קריאות שירות במפעל: העובד סורק QR ליד המכונה, מקליט סרטון של עד 30 שניות (וידאו + דיבור), והמערכת מנתחת את הסרטון ומציגה טיוטת קריאת שירות מובנית.

## איך זה עובד

```
טלפון (מצלמה) → /api/analyze → Gemini 2.5 Flash (ניתוח וידאו+אודיו) → GPT-4o (מבנה קריאת שירות JSON) → מסך תוצאה
```

- **Gemini** מקבל את קובץ הווידאו המלא (כולל אודיו) ומחזיר ניתוח בעברית: תמלול, מה רואים, מה התקלה.
- **GPT-4o** מקבל את הניתוח ובונה טיוטת קריאת שירות מובנית (JSON) — הבסיס לחיבור עתידי ל-Priority.
- מזהה המכונה מגיע מה-QR דרך פרמטר בכתובת: `https://your-app.vercel.app/?machine=M-101`

## פריסה ב-Vercel (מומלץ)

1. צור repository חדש ב-GitHub והעלה אליו את הקבצים (בלי `node_modules` ו-`.next` — הם ב-.gitignore).
2. ב-[vercel.com](https://vercel.com): **Add New → Project** → בחר את ה-repo → Vercel מזהה Next.js אוטומטית → **Deploy**.
3. ב-**Settings → Environment Variables** הוסף:
   - `GEMINI_API_KEY` — מפתח מ-[Google AI Studio](https://aistudio.google.com/apikey)
   - `OPENAI_API_KEY` — מפתח מ-[platform.openai.com](https://platform.openai.com/api-keys)
4. עשה **Redeploy** אחרי הוספת המפתחות.
5. פתח מהאייפון: `https://your-app.vercel.app/?machine=M-101` — ואשר גישה למצלמה ולמיקרופון.

## יצירת QR למכונה

לכל מכונה מייצרים QR שמצביע על הכתובת עם מזהה המכונה, למשל:
`https://your-app.vercel.app/?machine=CNC-07`

אפשר לייצר בחינם בכל מחולל QR, או בשורת פקודה:
```bash
pip install qrcode[pil]
python -c "import qrcode; qrcode.make('https://your-app.vercel.app/?machine=CNC-07').save('CNC-07.png')"
```

## ריצה מקומית

```bash
npm install
cp .env.local.example .env.local   # ולהזין את המפתחות
npm run dev
```
שים לב: מצלמה בדפדפן דורשת HTTPS או localhost. מהטלפון ברשת מקומית זה לא יעבוד בלי HTTPS — לכן Vercel הוא הדרך הקלה לבדיקה מהאייפון.

## מגבלות ידועות ב-POC

- **גודל קובץ**: Vercel מגביל בקשה ל-4.5MB, לכן ההקלטה מכווצת ל-640x480 בקצב נמוך (~3.2MB ל-30 שניות). איכות מספיקה לניתוח. בהמשך אפשר לעבור להעלאה ישירה ל-storage (S3/Blob) בלי מגבלה.
- **זמן ניתוח**: כ-20–40 שניות (העלאה ל-Gemini + עיבוד + GPT-4o).
- **iOS**: נתמך Safari מגרסה iOS 14.3 ומעלה (MediaRecorder).

## השלב הבא (מחוץ ל-POC)

- חיבור ל-Priority API לפתיחת קריאה אמיתית מתוך ה-JSON.
- מסך אישור לעובד לפני שליחה סופית ("זה מה שהבנתי — לאשר?").
- שמירת הסרטונים ב-storage וקישורם לקריאה.
- טבלת מכונות (QR → נתוני מכונה אמיתיים מפריוריטי).
