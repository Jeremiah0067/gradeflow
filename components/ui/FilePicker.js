'use client';

import { useState } from 'react';
import { Icon } from '../icons';

// A drop area that is also a big, obvious button. Works by click, keyboard, or drag and drop.
export function Dropzone({ title = 'Drop files here, or tap to choose', hint, accept, multiple = true, disabled = false, onFiles, icon = 'upload' }) {
  const [over, setOver] = useState(false);
  return (
    <label
      className={`dropzone${over ? ' is-over' : ''}${disabled ? ' is-disabled' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        if (!disabled) setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        if (!disabled) onFiles(Array.from(e.dataTransfer.files || []));
      }}
    >
      <Icon name={icon} size={28} />
      <span className="dropzone-title">{title}</span>
      {hint && <span className="dropzone-hint">{hint}</span>}
      <input
        type="file"
        className="visually-hidden"
        accept={accept}
        multiple={multiple}
        disabled={disabled}
        onChange={(e) => {
          const files = Array.from(e.target.files || []);
          e.target.value = '';
          onFiles(files);
        }}
      />
    </label>
  );
}

// For photographing scripts on a phone: the camera is the first choice, the gallery the second.
export function PhotoButtons({ onFiles, disabled = false, addMore = false }) {
  const handle = (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    onFiles(files);
  };
  return (
    <div className="picker-actions">
      <label className={`btn${disabled ? '' : ''}`} aria-disabled={disabled}>
        <Icon name="camera" size={18} />
        {addMore ? 'Take another photo' : 'Take a photo'}
        <input type="file" className="visually-hidden" accept="image/*" capture="environment" disabled={disabled} onChange={handle} />
      </label>
      <label className="btn btn-secondary" aria-disabled={disabled}>
        <Icon name="image" size={18} />
        Choose from gallery
        <input type="file" className="visually-hidden" accept="image/*" multiple disabled={disabled} onChange={handle} />
      </label>
    </div>
  );
}

export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// The list of chosen files under a picker
export function FileList({ files, onRemove, disabled }) {
  if (!files.length) return null;
  return (
    <ul className="filelist">
      {files.map((f, i) => (
        <li key={`${f.name}-${i}`} className="fileitem">
          <Icon name="file" size={16} />
          <span className="fileitem-name">{f.name}</span>
          <span className="fileitem-size">{formatBytes(f.size)}</span>
          <button type="button" className="btn-quiet btn-sm" disabled={disabled} onClick={() => onRemove(i)} aria-label={`Remove ${f.name}`}>
            Remove
          </button>
        </li>
      ))}
    </ul>
  );
}
