import '../styles/globals.css';

export const metadata = {
  title: 'GradeFlow',
  description: 'Assignment-focused classroom app with AI-assisted grading',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
