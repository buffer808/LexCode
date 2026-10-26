// Where Claude opens from `lexcode tui`: the modal (modal.ts, default) or, with "lexCode.tui.terminal": "inline",
// the whole terminal until Claude exits.
import { spawn } from 'child_process';

// key: which card the pane belongs to (story id, or a hash of the command for anything else).
// make: writes the launcher script; only called when a new pane is actually started.
export interface Pane {
  show(key: string): boolean;                  // bring back an existing pane for key; false = none
  open(key: string, label: string, make: () => string): void;
  focus(): void;
  state(): { open?: string; parked: string[] };
  // Short-lived program over the list (editor for long text, plan pager). The script writes its done file on exit.
  popup(make: () => string): void;
}

export function inlinePane(suspend: () => void, resume: () => void): Pane {
  return {
    show: () => false,
    open(_key, _label, make) {
      suspend();
      spawn('sh', [make()], { stdio: 'inherit' }).on('exit', resume).on('error', resume);
    },
    focus() {},
    state: () => ({ parked: [] }),
    popup(make) { this.open('', '', make); },
  };
}
