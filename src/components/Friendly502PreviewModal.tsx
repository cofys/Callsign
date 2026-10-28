import React from 'react';
import { ServiceMapping } from '../utils/lannameCore';

interface Friendly502PreviewModalProps {
  service: ServiceMapping | null;
  domain: string;
  onClose: () => void;
  onBringOnline: (name: string) => void;
}

export const Friendly502PreviewModal: React.FC<Friendly502PreviewModalProps> = ({
  service,
  domain,
  onClose,
  onBringOnline,
}) => {
  if (!service) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="modal-502-title"
    >
      <div className="w-full max-w-lg rounded-xl border border-slate-800 bg-[#111827] p-6 shadow-2xl">
        <div className="mb-4 flex items-center justify-between border-b border-slate-800 pb-3">
          <div className="text-xs font-mono text-slate-400">
            HTTP 502 Bad Gateway · Custom ErrorHandler Preview
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-2.5 py-1 text-xs font-medium text-slate-400 hover:bg-slate-800 hover:text-white whitespace-nowrap shrink-0"
          >
            Close Preview
          </button>
        </div>

        <div className="mb-3 text-xs font-medium text-red-400">
          502 Bad Gateway · Upstream Connection Refused
        </div>

        <h3 id="modal-502-title" className="text-xl font-bold text-slate-100">
          Service &ldquo;{service.name}&rdquo; is not responding
        </h3>
        <p className="mt-2 text-sm leading-relaxed text-slate-400">
          Connection refused by upstream target{' '}
          <code className="text-slate-200">{service.hostPort}</code> — is the
          service process or container running?
        </p>

        <div className="mt-5 space-y-2 rounded-lg border border-slate-800 bg-[#0b0f19] p-4 font-mono text-xs tabular-nums">
          <div className="flex justify-between">
            <span className="text-slate-500">Requested Host</span>
            <span className="text-slate-200">
              {service.name}.{domain} / {service.name}.local
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-slate-500">Upstream Target</span>
            <span className="text-slate-200">{service.targetUrl}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-slate-500">Auto-Retry Probe</span>
            <span className="text-sky-400">
              GET /__callsign_ping?service={service.name} (every 2s)
            </span>
          </div>
        </div>

        <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
          <button
            type="button"
            onClick={() => {
              onBringOnline(service.name);
              onClose();
            }}
            className="rounded-lg bg-emerald-600 px-4 py-2 text-xs font-semibold text-white hover:bg-emerald-500 transition-colors whitespace-nowrap shrink-0"
          >
            Simulate Starting Port ({service.hostPort})
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-slate-700 bg-slate-800 px-4 py-2 text-xs font-medium text-slate-200 hover:bg-slate-700 transition-colors whitespace-nowrap shrink-0"
          >
            Back to {domain}.local Hub
          </button>
        </div>
      </div>
    </div>
  );
};
