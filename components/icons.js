// A small set of line icons (one family, one stroke weight) used across the app.
const PATHS = {
  home: <><path d="M3 11.5 12 4l9 7.5" /><path d="M5.5 10v9.5h13V10" /><path d="M10 19.5v-5h4v5" /></>,
  book: <><path d="M12 7c-1.7-1.6-4.2-2.2-7.5-2.2v12.7c3.3 0 5.8.6 7.5 2.2 1.7-1.6 4.2-2.2 7.5-2.2V4.8C16.2 4.8 13.7 5.4 12 7Z" /><path d="M12 7v12.7" /></>,
  inbox: <><path d="M3.5 13.5 6 5.5h12l2.5 8" /><path d="M3.5 13.5v5h17v-5h-5l-1.5 2.5h-4L8.5 13.5h-5Z" /></>,
  pen: <><path d="M4 20l1-4.2L16.6 4.2a2.2 2.2 0 0 1 3.2 3.2L8.2 19 4 20Z" /><path d="m14.5 6.3 3.2 3.2" /></>,
  logout: <><path d="M10 4.5H5.5v15H10" /><path d="M15 8l4 4-4 4" /><path d="M19 12H9.5" /></>,
  camera: <><path d="M4 8.5h3l1.6-2.5h6.8L17 8.5h3v10H4v-10Z" /><circle cx="12" cy="13.2" r="3.4" /></>,
  upload: <><path d="M12 16V5" /><path d="m7.5 9.5 4.5-4.5 4.5 4.5" /><path d="M5 17v2.5h14V17" /></>,
  image: <><rect x="4" y="5" width="16" height="14" rx="2" /><circle cx="9" cy="10" r="1.6" /><path d="m5 17 4.5-4.5 3 3 2.5-2.5L19 16" /></>,
  file: <><path d="M7 3.5h7l4 4v13H7v-17Z" /><path d="M14 3.5v4h4" /></>,
  check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  chevronLeft: <path d="m14.5 6-6 6 6 6" />,
  chevronRight: <path d="m9.5 6 6 6-6 6" />,
  plus: <><path d="M12 5v14" /><path d="M5 12h14" /></>,
  alert: <><path d="M12 4 3 19.5h18L12 4Z" /><path d="M12 10v4.5" /><path d="M12 17.2v.1" /></>,
  calendar: <><rect x="4" y="5.5" width="16" height="14" rx="2" /><path d="M4 10h16" /><path d="M8.5 3.5v4" /><path d="M15.5 3.5v4" /></>,
  users: <><circle cx="9" cy="8.5" r="3.2" /><path d="M3.5 19c.4-3.2 2.6-5 5.5-5s5.1 1.8 5.5 5" /><path d="M16 5.6a3 3 0 0 1 0 5.8" /><path d="M17.5 14.3c1.7.5 2.8 2 3 4.7" /></>,
  clock: <><circle cx="12" cy="12" r="8" /><path d="M12 7.5V12l3 2" /></>,
  download: <><path d="M12 4.5v11" /><path d="m7.5 11.5 4.5 4.5 4.5-4.5" /><path d="M5 18v1.5h14V18" /></>,
};

export function Icon({ name, size = 20, strokeWidth = 2, ...rest }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {PATHS[name]}
    </svg>
  );
}
