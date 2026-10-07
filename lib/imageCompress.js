// Shrinks a phone photo before upload so batches of scripts upload quickly on weak
// mobile data and take less storage. It also fixes sideways photos (EXIF rotation).
//
// 2000px on the long edge keeps ordinary handwriting readable. If the AI struggles
// with small handwriting later, raise MAX_EDGE here (one place to change).
const MAX_EDGE = 2000;
const QUALITY = 0.82;

function loadViaImageElement(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('This photo could not be read. Try taking it again.'));
    };
    img.src = url;
  });
}

export async function compressImage(file) {
  let source;
  try {
    source = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    source = await loadViaImageElement(file);
  }

  const width = source.width;
  const height = source.height;
  const scale = Math.min(1, MAX_EDGE / Math.max(width, height));
  const targetW = Math.round(width * scale);
  const targetH = Math.round(height * scale);

  const canvas = document.createElement('canvas');
  canvas.width = targetW;
  canvas.height = targetH;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, targetW, targetH);
  ctx.drawImage(source, 0, 0, targetW, targetH);
  if (typeof source.close === 'function') source.close();

  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', QUALITY));
  if (!blob) throw new Error('This photo could not be processed. Try taking it again.');
  return blob;
}
