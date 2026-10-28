import React, { useState } from 'react';
import { validateTld } from '../utils/lannameCore';

interface SetupWizardViewProps {
  domain: string;
  lanIp: string;
  onSetDomain: (d: string) => void;
  onOpenMobileConfig: () => void;
  onOpenAndroidModal: () => void;
}

const QUICK_DOMAINS = [
  { id: 'x', label: '.x', desc: 'Ultra-short 1-letter custom ending' },
  { id: 'home', label: '.home', desc: 'Great for family & smart home' },
  { id: 'lan', label: '.lan', desc: 'Classic local network ending' },
  { id: 'box', label: '.box', desc: 'Simple & easy to type' },
];

export const SetupWizardView: React.FC<SetupWizardViewProps> = ({
  domain,
  lanIp,
  onSetDomain,
  onOpenMobileConfig,
  onOpenAndroidModal,
}) => {
  const [customInput, setCustomInput] = useState(domain);
  const [savedNotice, setSavedNotice] = useState(false);

  const cleanCandidate = customInput.trim().toLowerCase().replace(/^\.+|\.+$/g, '');
  const validation = validateTld(cleanCandidate || domain);

  const handleApplyDomain = (nextDomain: string) => {
    const normalized = nextDomain.trim().toLowerCase().replace(/^\.+|\.+$/g, '');
    if (!normalized) return;
    const check = validateTld(normalized);
    if (check.blocked) return;
    setCustomInput(normalized);
    onSetDomain(normalized);
    setSavedNotice(true);
    setTimeout(() => setSavedNotice(false), 2000);
  };

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      {/* Section 1: Pick Your Custom Ending */}
      <section className="rounded-2xl border border-slate-800/80 bg-[#111827] p-6 sm:p-8">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-semibold text-white">
            1. Pick Your Custom Ending
          </h2>
          {savedNotice && (
            <span className="text-xs font-medium text-emerald-400">
              ✓ Saved .{domain}
            </span>
          )}
        </div>
        <p className="mt-1 text-sm text-slate-400">
          Every app automatically works at <code className="text-slate-200">.local</code> (like{' '}
          <code className="text-sky-400">http://app.local</code>). Pick a custom ending if you also want{' '}
          <code className="text-sky-400">http://app.{domain}</code>.
        </p>

        <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {QUICK_DOMAINS.map((item) => {
            const active = domain === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => handleApplyDomain(item.id)}
                className={`rounded-xl border p-3.5 text-left transition-colors ${
                  active
                    ? 'border-sky-500 bg-sky-500/10 text-white'
                    : 'border-slate-800 bg-[#0b0f19] text-slate-300 hover:border-slate-700'
                }`}
              >
                <div className="font-mono text-sm font-bold text-white">
                  {item.label}
                </div>
                <div className="mt-1 text-xs text-slate-400">{item.desc}</div>
              </button>
            );
          })}
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            handleApplyDomain(customInput);
          }}
          className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center"
        >
          <div className="relative flex-1">
            <span className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 font-mono text-sm text-slate-500">
              .
            </span>
            <input
              type="text"
              value={customInput}
              onChange={(e) => setCustomInput(e.target.value)}
              placeholder="Or type your own (e.g. x, home, lab)"
              aria-label="Custom domain ending"
              className="w-full rounded-xl border border-slate-800 bg-[#0b0f19] py-2.5 pl-7 pr-3.5 font-mono text-sm text-white placeholder:font-sans placeholder:text-slate-500 focus:border-sky-500 focus:outline-none"
            />
          </div>
          <button
            type="submit"
            disabled={!cleanCandidate || validation.blocked}
            className="rounded-xl bg-sky-500 px-5 py-2.5 text-xs font-semibold text-slate-950 hover:bg-sky-400 disabled:opacity-40 whitespace-nowrap shrink-0"
          >
            Use .{cleanCandidate || domain}
          </button>
        </form>

        {validation.tier !== 'GREEN' && (
          <p
            className={`mt-2.5 text-xs ${
              validation.tier === 'RED' ? 'text-red-400' : 'text-amber-300'
            }`}
          >
            {validation.message}
          </p>
        )}
      </section>

      {/* Section 2: Connect Your Devices */}
      <section className="rounded-2xl border border-slate-800/80 bg-[#111827] p-6 sm:p-8">
        <h2 className="text-lg font-semibold text-white">
          2. Connect Your Phones &amp; Computers
        </h2>
        <p className="mt-1 text-sm text-slate-400">
          Pick the device you are using right now:
        </p>

        <div className="mt-5 divide-y divide-slate-800/80 rounded-xl border border-slate-800 bg-[#0b0f19]">
          {/* Computers */}
          <div className="flex flex-col justify-between gap-3 p-4 sm:flex-row sm:items-center">
            <div>
              <div className="text-sm font-semibold text-white">
                Mac &amp; Windows Computers
              </div>
              <p className="mt-0.5 text-xs text-slate-400">
                Works automatically. Open <code className="text-sky-400">http://&lt;app&gt;.local</code> in any browser.
              </p>
            </div>
            <span className="text-xs font-medium text-emerald-400 whitespace-nowrap shrink-0">
              ✓ No setup needed
            </span>
          </div>

          {/* iPhone & iPad */}
          <div className="flex flex-col justify-between gap-3 p-4 sm:flex-row sm:items-center">
            <div>
              <div className="text-sm font-semibold text-white">
                iPhone &amp; iPad
              </div>
              <p className="mt-0.5 text-xs text-slate-400">
                <code className="text-sky-400">.local</code> works automatically. For <code className="text-sky-400">.{domain}</code> links, install the 1-click profile.
              </p>
            </div>
            <button
              type="button"
              onClick={onOpenMobileConfig}
              className="rounded-lg border border-slate-700 bg-[#111827] px-3.5 py-2 text-xs font-medium text-slate-200 hover:bg-slate-800 whitespace-nowrap shrink-0"
            >
              Get iPhone Profile
            </button>
          </div>

          {/* Android */}
          <div className="flex flex-col justify-between gap-3 p-4 sm:flex-row sm:items-center">
            <div>
              <div className="text-sm font-semibold text-white">
                Android Phones
              </div>
              <p className="mt-0.5 text-xs text-slate-400">
                Download the Universal APK app (or use the 15-second Wi-Fi DNS shortcut).
              </p>
            </div>
            <button
              type="button"
              onClick={onOpenAndroidModal}
              className="rounded-lg border border-slate-700 bg-[#111827] px-3.5 py-2 text-xs font-medium text-slate-200 hover:bg-slate-800 whitespace-nowrap shrink-0"
            >
              Get Android App (APK)
            </button>
          </div>
        </div>
      </section>
    </div>
  );
};
