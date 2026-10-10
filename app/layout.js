import '@fontsource-variable/atkinson-hyperlegible-next';
import '../styles/globals.css';
import AppShell from '../components/AppShell';

export const metadata = {
  title: 'GradeFlow',
  description: 'Assignment-focused classroom app with AI-assisted grading',
};

export const viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#2340b4',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>
        <a href="#main" className="visually-hidden">
          Skip to content
        </a>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
