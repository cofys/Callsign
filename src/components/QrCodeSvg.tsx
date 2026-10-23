import React from 'react';
import { generateOfflineQrMatrix } from '../utils/lannameCore';

interface QrCodeSvgProps {
  value: string;
  size?: number;
}

export const QrCodeSvg: React.FC<QrCodeSvgProps> = ({ value, size = 176 }) => {
  const matrix = React.useMemo(() => generateOfflineQrMatrix(value), [value]);
  const dim = matrix.length;

  return (
    <div className="inline-flex items-center justify-center rounded-xl bg-white p-4">
      <svg
        viewBox={`0 0 ${dim} ${dim}`}
        width={size}
        height={size}
        shapeRendering="crispEdges"
        role="img"
        aria-label={`QR code for ${value}`}
      >
        {matrix.map((row, r) =>
          row.map((cell, c) =>
            cell === 1 ? (
              <rect
                key={`${r}-${c}`}
                x={c}
                y={r}
                width={1}
                height={1}
                fill="#0b0f19"
              />
            ) : null
          )
        )}
      </svg>
    </div>
  );
};
