import React, { useState } from 'react';
import { generateMobileConfigXml } from '../utils/callsignCore';

interface MobileConfigModalProps {
  open: boolean;
  domain: string;
  lanIp: string;
  onClose: () => void;
}

export const MobileConfigModal: React.FC<MobileConfigModalProps> = ({
  open,
  domain,
  lanIp,
  onClose,
}) => {
  const [copied, setCopied] = useState(false);

  if (!open) return null;

  const xml = generateMobileConfigXml(domain, lanIp);

  const handleDownload = () => {
    const blob = new Blob([xml], {
      type: 'application/x-apple-aspen-config;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `callsign-${domain}.mobileconfig`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleCopy = () => {
    navigator.clipboard.writeText(xml);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="mobileconfig-modal-title"
    >
      <div className="flex max-h-[88vh] w-full max-w-2xl flex-col rounded-xl border border-slate-800 bg-[#111827] p-6 shadow-2xl">
        <div className="flex items-start justify-between gap-4 border-b border-slate-800 pb-4">
          <div>
            <h3
              id="mobileconfig-modal-title"
              className="text-lg font-bold text-slate-100"
            >
              iOS &amp; macOS Split-DNS Profile (/setup/ios.mobileconfig)
            </h3>
            <p className="mt-1 text-xs text-slate-400">
              Uses Apple&apos;s <code className="text-sky-400">com.apple.dnsSettings.managed</code>{' '}
              payload with <code className="text-sky-400">SupplementalMatchDomains: [&quot;{domain}&quot;]</code>{' '}
              so iPhones and Macs resolve <code className="text-slate-200">*.{domain}</code> via{' '}
              <code className="text-slate-200">{lanIp}</code> without changing router DHCP.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-3 py-1.5 text-xs font-medium text-slate-400 hover:bg-slate-800 hover:text-white whitespace-nowrap shrink-0"
          >
            Close
          </button>
        </div>

        <div className="my-4 overflow-y-auto rounded-lg border border-slate-800 bg-[#0b0f19] p-4">
          <pre className="font-mono text-xs leading-relaxed text-slate-300 overflow-x-auto">
            {xml}
          </pre>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
          <div className="text-xs text-slate-400">
            Tap &ldquo;Install Profile&rdquo; in iOS Settings after downloading.
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleCopy}
              className="rounded-lg border border-slate-700 bg-slate-800 px-3.5 py-2 text-xs font-medium text-slate-200 hover:bg-slate-700 transition-colors whitespace-nowrap shrink-0"
            >
              {copied ? 'Copied XML' : 'Copy Profile XML'}
            </button>
            <button
              type="button"
              onClick={handleDownload}
              className="rounded-lg bg-sky-500 px-4 py-2 text-xs font-semibold text-slate-950 hover:bg-sky-400 transition-colors whitespace-nowrap shrink-0"
            >
              Download callsign-{domain}.mobileconfig
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
