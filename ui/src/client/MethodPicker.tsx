// The method field: still free text (any custom verb is sent as-is), but with
// a real dropdown of the preset verbs. A <datalist> only suggested verbs that
// matched what was already typed, so with "GET" in the box the other seventeen
// were never one click away.

import { Fragment, useEffect, useId, useRef, useState } from 'react';

import { METHODS, STANDARD_METHODS } from '../../../shared/collections.ts';

const PRESETS: readonly string[] = METHODS;
const isStandard = (m: string) => (STANDARD_METHODS as readonly string[]).includes(m);

interface Props {
  id: string;
  value: string;
  onChange: (method: string) => void;
  /** Enter with no option highlighted - the URL bar's "send" */
  onEnter: () => void;
  describedBy?: string;
}

export function MethodPicker({ id, value, onChange, onEnter, describedBy }: Props) {
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  // Typing narrows the list to verbs starting with the text; opening it from
  // the chevron or a click shows all of them, whatever is in the box.
  const [filtering, setFiltering] = useState(false);
  const [active, setActive] = useState(-1);

  const current = value.trim().toUpperCase();
  const options = filtering && current ? PRESETS.filter((m) => m.startsWith(current)) : PRESETS;
  const showList = open && options.length > 0;

  useEffect(() => {
    if (showList && active >= 0) document.getElementById(`${listId}-${active}`)?.scrollIntoView({ block: 'nearest' });
  }, [showList, active, listId]);

  const openAll = () => {
    setFiltering(false);
    setActive(PRESETS.indexOf(current));
    setOpen(true);
  };

  const close = () => {
    setOpen(false);
    setActive(-1);
  };

  const choose = (m: string) => {
    onChange(m);
    close();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!showList) return openAll();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setActive((i) => (i < 0 ? (step > 0 ? 0 : options.length - 1) : (i + step + options.length) % options.length));
      return;
    }
    if (e.key === 'Enter') {
      const picked = showList ? options[active] : undefined;
      if (picked) {
        e.preventDefault();
        return choose(picked);
      }
      close();
      return onEnter();
    }
    if (e.key === 'Escape' && showList) {
      // stop here, so a surrounding panel doesn't close along with the list
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };

  return (
    <div className="relative w-32 shrink-0">
      <input
        ref={inputRef}
        id={id}
        role="combobox"
        aria-expanded={showList}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={showList && active >= 0 ? `${listId}-${active}` : undefined}
        aria-describedby={describedBy}
        value={value}
        placeholder="GET"
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => {
          onChange(e.target.value.toUpperCase());
          setFiltering(true);
          setActive(-1);
          setOpen(true);
        }}
        onClick={() => !showList && openAll()}
        onKeyDown={onKeyDown}
        onBlur={close}
        className="h-9 w-full rounded border border-slate-300 bg-white pl-2 pr-7 text-sm font-semibold uppercase dark:border-slate-700 dark:bg-slate-800"
      />
      {/* no focus of its own: mousedown is swallowed so the input keeps it */}
      <button
        type="button"
        tabIndex={-1}
        aria-label="Show methods"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          if (showList) return close();
          inputRef.current?.focus();
          openAll();
        }}
        className="absolute inset-y-0 right-0 flex w-7 items-center justify-center text-xs text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
      >
        <i className={`fa-solid fa-chevron-down transition-transform ${showList ? 'rotate-180' : ''}`} />
      </button>

      {showList && (
        <ul
          id={listId}
          role="listbox"
          aria-label="HTTP methods"
          onMouseDown={(e) => e.preventDefault()}
          className="absolute left-0 top-full z-30 mt-1 max-h-96 w-44 overflow-y-auto rounded-lg border border-slate-200 bg-white py-1 shadow-lg dark:border-slate-800 dark:bg-slate-900"
        >
          {options.map((m, i) => (
            <Fragment key={m}>
              {!isStandard(m) && (i === 0 || isStandard(options[i - 1]!)) && (
                <li
                  role="presentation"
                  className={`px-3 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400 ${
                    i > 0 ? 'mt-1 border-t border-slate-200 dark:border-slate-800' : ''
                  }`}
                >
                  Extended · sent as-is
                </li>
              )}
              <li
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === active}
                onMouseEnter={() => setActive(i)}
                onClick={() => choose(m)}
                className={`flex cursor-pointer items-center justify-between px-3 py-1.5 text-sm font-semibold ${
                  i === active ? 'bg-slate-100 dark:bg-slate-800' : ''
                }`}
              >
                {m}
                {m === current && <i className="fa-solid fa-check text-xs text-indigo-600 dark:text-indigo-400" />}
              </li>
            </Fragment>
          ))}
        </ul>
      )}
    </div>
  );
}
