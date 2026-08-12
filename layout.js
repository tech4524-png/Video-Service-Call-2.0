export const metadata = {
  title: 'קריאת שירות בווידאו',
  description: 'פתיחת קריאת שירות באמצעות סרטון וידאו',
};

export const viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  themeColor: '#0f172a',
};

export default function RootLayout({ children }) {
  return (
    <html lang="he" dir="rtl">
      <body style={{ margin: 0, background: '#0f172a', color: '#e2e8f0', fontFamily: "-apple-system, 'Segoe UI', 'Heebo', Arial, sans-serif" }}>
        <style>{`@keyframes spin { to { transform: rotate(360deg); } } button { cursor: pointer; }`}</style>
        {children}
      </body>
    </html>
  );
}
