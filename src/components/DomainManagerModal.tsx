import React, { useState } from 'react';
import { validateTld, normalizeDomain } from '../utils/callsignCore';

interface DomainManagerModalProps {
  open: boolean;
  currentDomain: string;
  onClose: () => void;
  onSaveDomain: (newDomain: string) => void;
}

const PRESET_DOMAINS = [
  { domain: 'x', label: '.x', desc: 'Ultra-short 1-letter custom suffix' },
  { domain: 'home', label: '.home', desc: 'Standard private home network suffix' },
  { domain: 'lan', label: '.lan', desc: 'Universal Local Area Network suffix' },
  { domain: 'lab', label: '.lab', desc: 'Homelab & self-hosting server domain' },
  { domain: 'box', label: '.box', desc: 'Short, clean personal box suffix' },
  { domain: 'home.arpa', label: '.home.arpa', desc: 'Official IETF RFC 8375 non-delegated home domain' },
];

export const DomainManagerModal: React.FC<DomainManagerModalProps> = ({
  open,
  currentDomain,
  onClose,
  onSaveDomain,
}) => {
  const [domainInput, setDomainInput] = useState(currentDomain);
  const [force, setForce] = useState(false);

  if (!open) return null;

  const validation = validateTld(domainInput, force);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (validation.blocked) return;
    onSaveDomain(normalizeDomain(domainInput));
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="domain-manager-title"
    >
      <div className="w-full max-w-lg rounded-xl border border-slate-800 bg-[#111827] p-6 shadow-2xl">
        <div className="flex items-start justify-between gap-4 border-b border-slate-800 pb-4">
          <div>
            <h3 id="domain-manager-title" className="text-lg font-bold text-slate-100">
              Customize Your Local Domain Suffix
            </h3>
            <p className="mt-1 text-xs text-slate-400">
              Change the default suffix from <code className="text-sky-400">.{currentDomain}</code> to any custom name you prefer (e.g. <code className="text-slate-200">.home</code>, <code className="text-slate-200">.lab</code>, or your family name).
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-2.5 py-1 text-xs font-medium text-slate-400 hover:bg-slate-800 hover:text-white"
          >
            Close
          </button>
        </div>

        <form onSubmit={handleSubmit} className="mt-5 space-y-4">
          <div>
            <label className="block text-xs font-medium text-slate-300 mb-2">
              Popular Safe Home Network Domains
            </label>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {PRESET_DOMAINS.map((item) => (
                <button
                  key={item.domain}
                  type="button"
                  onClick={() => setDomainInput(item.domain)}
                  className={`rounded-lg border p-2.5 text-left transition-colors ${
                    domainInput.toLowerCase() === item.domain
                      ? 'border-sky-500 bg-sky-950/40 text-sky-200'
                      : 'border-slate-800 bg-[#0b0f19] text-slate-300 hover:border-slate-700'
                  }`}
                >
                  <div className="font-mono text-xs font-bold">{item.label}</div>
                  <div className="mt-0.5 text-[11px] text-slate-400 truncate">{item.desc}</div>
                </button>
              ))}
            </div>
          </div>

          <div>
            <label htmlFor="custom-domain-field" className="block text-xs font-medium text-slate-300 mb-1.5">
              Custom Domain Suffix (Type anything you like)
            </label>
            <div className="flex items-center gap-2">
              <span className="font-mono text-sm text-slate-400">.</span>
              <input
                id="custom-domain-field"
                type="text"
                required
                value={domainInput}
                onChange={(e) => setDomainInput(e.target.value)}
                placeholder="home, lab, smith, etc."
                className="w-full rounded-lg border border-slate-700 bg-[#0b0f19] px-3.5 py-2 font-mono text-sm text-slate-100 focus:border-sky-400 focus:outline-none"
              />
            </div>
          </div>

          {/* Validation Feedback */}
          <div className="rounded-lg border border-slate-800 bg-[#0b0f19] p-3 text-xs leading-relaxed">
            <div className="flex items-center justify-between font-semibold">
              <span
                className={
                  validation.tier === 'GREEN'
                    ? 'text-emerald-400'
                    : validation.tier === 'YELLOW'
                    ? 'text-amber-400'
                    : 'text-red-400'
                }
              >
                Safety Tier: {validation.tier} ({validation.title})
              </span>
              <span className="font-mono text-[11px] text-slate-400">
                {validation.blocked ? 'Requires --force' : 'Ready to use'}
              </span>
            </div>
            <p className="mt-1.5 text-slate-300">{validation.message}</p>
          </div>

          {validation.tier === 'RED' && (
            <div className="flex items-center gap-2">
              <input
                id="force-domain-override"
                type="checkbox"
                checked={force}
                onChange={(e) => setForce(e.target.checked)}
                className="h-4 w-4 rounded border-slate-700 bg-slate-900"
              />
              <label htmlFor="force-domain-override" className="text-xs text-slate-400">
                Allow HSTS-preloaded domain anyway (not recommended)
              </label>
            </div>
          )}

          <div className="flex items-center justify-end gap-2.5 pt-2 border-t border-slate-800">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-slate-700 bg-slate-800 px-4 py-2 text-xs font-medium text-slate-300 hover:bg-slate-700 whitespace-nowrap shrink-0"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={validation.blocked}
              className="rounded-lg bg-sky-500 px-4 py-2 text-xs font-semibold text-slate-950 hover:bg-sky-400 disabled:opacity-40 transition-colors whitespace-nowrap shrink-0"
            >
              Set Active Domain (.{normalizeDomain(domainInput)})
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
