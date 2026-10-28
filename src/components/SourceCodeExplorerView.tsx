import React, { useState } from 'react';
import { GO_SOURCE_FILES } from '../data/goSourceFiles';

export const SourceCodeExplorerView: React.FC = () => {
  const [selectedPath, setSelectedPath] = useState<string>(
    GO_SOURCE_FILES[0].path
  );
  const [copiedPath, setCopiedPath] = useState<string | null>(null);

  const activeFile =
    GO_SOURCE_FILES.find((f) => f.path === selectedPath) || GO_SOURCE_FILES[0];

  const handleCopyFile = (path: string, content: string) => {
    navigator.clipboard.writeText(content);
    setCopiedPath(path);
    setTimeout(() => setCopiedPath(null), 1800);
  };

  const handleDownloadFile = (path: string, content: string) => {
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = path.split('/').pop() || 'file.go';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-slate-800 bg-[#111827] p-5">
        <div>
          <h2 className="text-lg font-bold text-slate-100">
            Complete Production Go Codebase ({GO_SOURCE_FILES.length} Files)
          </h2>
          <p className="mt-1 text-xs text-slate-400">
            Every file is written directly to the workspace and compiled against Go 1.22+ with{' '}
            <code className="text-slate-200">github.com/miekg/dns</code>,{' '}
            <code className="text-slate-200">golang.org/x/net/ipv4</code>, and{' '}
            <code className="text-slate-200">gopkg.in/yaml.v3</code>.
          </p>
        </div>
        <div className="font-mono text-xs text-slate-400">
          go build -o callsign ./cmd/lanname
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12 items-stretch">
        {/* Sidebar File List */}
        <aside className="lg:col-span-4 space-y-1.5 max-h-[720px] overflow-y-auto pr-1">
          {GO_SOURCE_FILES.map((file) => {
            const isSelected = file.path === activeFile.path;
            const lineCount = file.content.split('\n').length;
            return (
              <button
                key={file.path}
                type="button"
                onClick={() => setSelectedPath(file.path)}
                className={`w-full rounded-lg border p-3 text-left transition-colors ${
                  isSelected
                    ? 'border-sky-500/60 bg-slate-800/90 text-white'
                    : 'border-slate-800 bg-[#111827] text-slate-300 hover:bg-slate-800/40'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-xs font-semibold text-sky-400 truncate">
                    {file.path}
                  </span>
                  <span className="font-mono text-[11px] text-slate-400 tabular-nums shrink-0">
                    {lineCount} lines
                  </span>
                </div>
                <p className="mt-1 text-xs text-slate-400 line-clamp-2">
                  {file.summary}
                </p>
              </button>
            );
          })}
        </aside>

        {/* Code Viewer */}
        <div className="lg:col-span-8 flex flex-col rounded-xl border border-slate-800 bg-[#111827] overflow-hidden max-h-[720px]">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 bg-[#0b0f19] px-5 py-3.5 shrink-0">
            <div>
              <div className="font-mono text-sm font-semibold text-slate-100">
                {activeFile.path}
              </div>
              <div className="text-xs text-slate-400 mt-0.5">
                {activeFile.summary}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() =>
                  handleCopyFile(activeFile.path, activeFile.content)
                }
                className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-700 transition-colors whitespace-nowrap shrink-0"
              >
                {copiedPath === activeFile.path ? 'Copied!' : 'Copy File'}
              </button>
              <button
                type="button"
                onClick={() =>
                  handleDownloadFile(activeFile.path, activeFile.content)
                }
                className="rounded-lg bg-sky-500 px-3 py-1.5 text-xs font-semibold text-slate-950 hover:bg-sky-400 transition-colors whitespace-nowrap shrink-0"
              >
                Download
              </button>
            </div>
          </div>

          <div className="flex-1 overflow-auto p-5 bg-[#0b0f19]">
            <pre className="font-mono text-xs leading-relaxed text-slate-200">
              <code>{activeFile.content}</code>
            </pre>
          </div>
        </div>
      </div>
    </div>
  );
};
