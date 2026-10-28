import React, { useState } from 'react';
import { QrCodeSvg } from './QrCodeSvg';
import { buildUniversalApkBundleBytes } from '../utils/apkBundleGenerator';
import androidManifestRaw from '../../android/AndroidManifest.xml?raw';
import mainActivityKtRaw from '../../android/MainActivity.kt?raw';
import lannameVpnKtRaw from '../../android/LannameVpnService.kt?raw';
import buildGradleKtRaw from '../../android/build.gradle.kts?raw';

interface AndroidCompanionModalProps {
  open: boolean;
  domain: string;
  lanIp: string;
  onClose: () => void;
  onInspectSource: () => void;
}

export const AndroidCompanionModal: React.FC<AndroidCompanionModalProps> = ({
  open,
  domain,
  lanIp,
  onClose,
  onInspectSource,
}) => {
  const [mode, setMode] = useState<'apk' | 'wifi'>('apk');
  const [downloaded, setDownloaded] = useState(false);

  if (!open) return null;

  const apkDownloadUrl = `http://${lanIp}/setup/callsign-companion.apk`;
  const deepLinkUri = `callsign://configure?ip=${lanIp}&domain=${domain}`;

  const handleDownloadApk = () => {
    const bytes = buildUniversalApkBundleBytes({
      lanIp,
      domain,
      instanceId: 'cs-9f8e7d6c5b4a3210',
      manifestXml: androidManifestRaw,
      mainActivityKt: mainActivityKtRaw,
      vpnServiceKt: lannameVpnKtRaw,
      buildGradleKts: buildGradleKtRaw,
    });
    const blob = new Blob([bytes], {
      type: 'application/vnd.android.package-archive',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `callsign-companion-${domain}-universal.apk`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    setDownloaded(true);
    setTimeout(() => setDownloaded(false), 2500);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="android-modal-title"
    >
      <div className="w-full max-w-lg rounded-2xl border border-slate-800 bg-[#111827] p-6 shadow-2xl">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 id="android-modal-title" className="text-lg font-bold text-white">
              Connect Your Android Phone
            </h3>
            <p className="mt-1 text-xs text-slate-400">
              Enable <code className="text-sky-400">http://&lt;app&gt;.local</code> and{' '}
              <code className="text-sky-400">http://&lt;app&gt;.{domain}</code> on Android.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close modal"
            className="rounded-lg px-2 py-1 text-xs text-slate-400 hover:bg-slate-800 hover:text-white"
          >
            ✕
          </button>
        </div>

        {/* Simple Mode Switcher */}
        <div className="mt-4 flex gap-1 rounded-xl border border-slate-800 bg-[#0b0f19] p-1">
          <button
            type="button"
            onClick={() => setMode('apk')}
            className={`flex-1 rounded-lg py-2 text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
              mode === 'apk'
                ? 'bg-sky-500 text-slate-950'
                : 'text-slate-400 hover:text-white'
            }`}
          >
            Option 1: Universal APK App
          </button>
          <button
            type="button"
            onClick={() => setMode('wifi')}
            className={`flex-1 rounded-lg py-2 text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
              mode === 'wifi'
                ? 'bg-sky-500 text-slate-950'
                : 'text-slate-400 hover:text-white'
            }`}
          >
            Option 2: No-App Wi-Fi Setting
          </button>
        </div>

        {mode === 'apk' ? (
          <div className="mt-5 space-y-4">
            <div className="flex flex-col items-center gap-5 rounded-xl border border-slate-800 bg-[#0b0f19] p-5 sm:flex-row">
              <div className="shrink-0">
                <QrCodeSvg value={apkDownloadUrl} />
              </div>

              <div className="space-y-2 text-left">
                <div className="text-sm font-semibold text-white">
                  Pre-Configured for .{domain} ({lanIp})
                </div>
                <p className="text-xs leading-relaxed text-slate-400">
                  Works on all Android phones (Samsung, Pixel, OnePlus, Motorola). Automatically turns on when you join home Wi-Fi and turns off when you leave.
                </p>
                <div className="pt-1 font-mono text-[11px] text-sky-400 break-all">
                  {deepLinkUri}
                </div>
              </div>
            </div>

            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <button
                type="button"
                onClick={handleDownloadApk}
                className="flex-1 rounded-xl bg-sky-500 px-4 py-2.5 text-xs font-bold text-slate-950 hover:bg-sky-400 transition-colors whitespace-nowrap shrink-0"
              >
                {downloaded
                  ? '✓ Downloaded Universal APK'
                  : `Download Universal APK (callsign-${domain}.apk)`}
              </button>
              <button
                type="button"
                onClick={() => {
                  onClose();
                  onInspectSource();
                }}
                className="rounded-xl border border-slate-700 bg-[#0b0f19] px-3.5 py-2.5 text-xs font-medium text-slate-300 hover:bg-slate-800 whitespace-nowrap shrink-0"
              >
                Inspect APK Code
              </button>
            </div>
          </div>
        ) : (
          <div className="mt-5 space-y-4">
            <div className="rounded-xl border border-slate-800 bg-[#0b0f19] p-4 space-y-3">
              <div className="text-xs font-semibold text-emerald-400">
                ✓ Works in 15 Seconds — No App Install Needed
              </div>
              <p className="text-xs text-slate-300 leading-relaxed">
                Android saves this setting <strong>only for your home Wi-Fi</strong> (it never affects cellular data or coffee-shop Wi-Fi):
              </p>
              <ol className="space-y-2 text-xs text-slate-300 list-decimal list-inside">
                <li>
                  Open Android <strong>Settings → Wi-Fi</strong> and tap the <strong>Gear icon ⚙️</strong> next to your home network.
                </li>
                <li>
                  Tap <strong>View more → IP settings</strong> and change <em>DHCP</em> to <strong>Static</strong>.
                </li>
                <li>
                  Scroll to <strong>DNS 1</strong>, type <code className="font-mono font-bold text-sky-400">{lanIp}</code>, and tap <strong>Save</strong>.
                </li>
              </ol>
            </div>
          </div>
        )}

        <div className="mt-5 flex justify-end border-t border-slate-800 pt-4">
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl border border-slate-700 bg-slate-800 px-5 py-2 text-xs font-medium text-slate-200 hover:bg-slate-700"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
};
