// CodeMirror 6 wrapper used for request bodies and scripts.
//
// Kept thin on purpose: syntax highlighting, line numbers and bracket matching
// are what a body/script editor needs; everything fancier belongs to the panes
// around it.

import { useEffect, useState } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { oneDark } from '@codemirror/theme-one-dark';

type Language = 'json' | 'javascript' | 'text';

interface Props {
  value: string;
  onChange: (value: string) => void;
  language: Language;
  ariaLabel: string;
  placeholder?: string;
  height?: string;
}

function useDarkMode(): boolean {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'));
  useEffect(() => {
    const observer = new MutationObserver(() =>
      setDark(document.documentElement.classList.contains('dark')),
    );
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);
  return dark;
}

export function CodeEditor({
  value,
  onChange,
  language,
  ariaLabel,
  placeholder,
  height = '100%',
}: Props) {
  const dark = useDarkMode();
  const extensions =
    language === 'json' ? [json()] : language === 'javascript' ? [javascript()] : [];

  return (
    <div
      aria-label={ariaLabel}
      className="h-full min-h-0 overflow-hidden rounded border border-slate-300 dark:border-slate-700"
    >
      <CodeMirror
        value={value}
        onChange={onChange}
        height={height}
        theme={dark ? oneDark : 'light'}
        extensions={extensions}
        placeholder={placeholder}
        basicSetup={{
          lineNumbers: true,
          foldGutter: true,
          highlightActiveLine: false,
          highlightActiveLineGutter: false,
          autocompletion: language !== 'text',
        }}
        style={{ fontSize: 12, height: '100%' }}
      />
    </div>
  );
}
