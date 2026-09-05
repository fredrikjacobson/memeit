import { CHEAT_ROWS } from '../lib/keys';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from './ui/dialog';
import { Keyboard } from 'lucide-react';

export default function CheatSheet({ onClose }: { onClose: () => void }) {
  return (
    <Dialog open onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-3xl sm:max-w-3xl max-h-[calc(100%-2rem)] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm">
            <Keyboard className="size-4 shrink-0" />
            <span>Keyboard shortcuts</span>
            <span className="font-normal normal-case tracking-normal text-muted-foreground">
              vim-style · inactive while typing · Esc closes
            </span>
          </DialogTitle>
        </DialogHeader>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {CHEAT_ROWS.map((group, i) => (
            <div key={i} className="flex min-w-0 flex-col gap-2 rounded-lg border border-border bg-muted/30 p-3">
              {group.map((r) => (
                <div key={r.keys} className="flex items-start gap-2 text-xs">
                  <kbd className="shrink-0 whitespace-nowrap rounded-md border border-border border-b-2 bg-background px-1.5 py-0.5 font-[inherit] text-[11px]">
                    {r.keys}
                  </kbd>
                  <span className="min-w-0 leading-snug text-muted-foreground">{r.what}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
        <div className="text-xs text-muted-foreground">
          Tips:{' '}
          <Kbd>t</Kbd> then type immediately · <Kbd>s</Kbd> chains the next line ·{' '}
          <Kbd>n</Kbd> hops between captions · <Kbd>0</Kbd>/<Kbd>$</Kbd> jump to the
          selected clip&apos;s edges · <Kbd>g</Kbd>
          <Kbd>g</Kbd>/<Kbd>G</Kbd> timeline ends.
        </div>
        <div className="flex justify-end">
          <Button size="sm" onClick={onClose}>Close</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="whitespace-nowrap rounded-md border border-border border-b-2 bg-background px-1.5 py-0.5 font-[inherit] text-[11px]">
      {children}
    </kbd>
  );
}
