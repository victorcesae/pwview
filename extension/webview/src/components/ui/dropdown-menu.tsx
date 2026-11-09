import { ChevronRight } from 'lucide-react';
import { DropdownMenu as DM } from 'radix-ui';
import * as React from 'react';
import { cn } from '@/lib/utils';

const DropdownMenu = DM.Root;
const DropdownMenuTrigger = DM.Trigger;
const DropdownMenuSub = DM.Sub;

const panel = 'bg-popover text-popover-foreground animate-in fade-in-0 zoom-in-95 z-50 min-w-56 overflow-hidden rounded-xl border p-1 shadow-lg';

function DropdownMenuContent({ className, sideOffset = 6, ...props }: React.ComponentProps<typeof DM.Content>) {
  return (
    <DM.Portal>
      <DM.Content sideOffset={sideOffset} className={cn(panel, className)} {...props} />
    </DM.Portal>
  );
}

function DropdownMenuSubContent({ className, ...props }: React.ComponentProps<typeof DM.SubContent>) {
  return (
    <DM.Portal>
      <DM.SubContent sideOffset={6} className={cn(panel, className)} {...props} />
    </DM.Portal>
  );
}

const item =
  "focus:bg-accent focus:text-accent-foreground data-[state=open]:bg-accent relative flex cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[12.5px] outline-none select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg:not([class*='size-'])]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground";

function DropdownMenuItem({ className, ...props }: React.ComponentProps<typeof DM.Item>) {
  return <DM.Item className={cn(item, className)} {...props} />;
}

function DropdownMenuSubTrigger({ className, children, ...props }: React.ComponentProps<typeof DM.SubTrigger>) {
  return (
    <DM.SubTrigger className={cn(item, className)} {...props}>
      {children}
      <ChevronRight className="ml-auto size-3.5" />
    </DM.SubTrigger>
  );
}

function DropdownMenuSeparator({ className, ...props }: React.ComponentProps<typeof DM.Separator>) {
  return <DM.Separator className={cn('bg-border -mx-1 my-1 h-px', className)} {...props} />;
}

function DropdownMenuLabel({ className, ...props }: React.ComponentProps<typeof DM.Label>) {
  return <DM.Label className={cn('text-muted-foreground px-2.5 py-1 text-[11px]', className)} {...props} />;
}

function DropdownMenuShortcut({ className, ...props }: React.ComponentProps<'span'>) {
  return <span className={cn('text-muted-foreground ml-auto pl-4 text-[11px] tracking-wide', className)} {...props} />;
}

/** A small on/off switch for menu rows. */
function Switch({ on }: { on: boolean }) {
  return (
    <span className={cn('relative ml-auto inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors', on ? 'bg-primary' : 'bg-muted-foreground/40')} aria-hidden>
      <span className={cn('bg-background inline-block size-3 rounded-full shadow transition-transform', on ? 'translate-x-3.5' : 'translate-x-0.5')} />
    </span>
  );
}

export { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuShortcut, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger, Switch };
