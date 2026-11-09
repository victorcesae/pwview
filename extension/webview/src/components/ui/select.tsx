import { Check, ChevronDown } from 'lucide-react';
import { Select as SelectPrimitive } from 'radix-ui';
import * as React from 'react';
import { cn } from '@/lib/utils';

const Select = SelectPrimitive.Root;
const SelectValue = SelectPrimitive.Value;

function SelectTrigger({ className, children, ...props }: React.ComponentProps<typeof SelectPrimitive.Trigger>) {
  return (
    <SelectPrimitive.Trigger
      data-slot="select-trigger"
      className={cn(
        'text-muted-foreground hover:text-foreground hover:bg-accent data-[state=open]:bg-accent data-[state=open]:text-foreground inline-flex h-7 max-w-48 cursor-pointer items-center gap-1 rounded-md px-2 text-[12px] whitespace-nowrap transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/60 [&_svg]:size-3.5 [&_svg]:shrink-0 [&>span]:truncate',
        className,
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon asChild>
        <ChevronDown className="opacity-60" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}

function SelectContent({ className, children, position = 'popper', ...props }: React.ComponentProps<typeof SelectPrimitive.Content>) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        data-slot="select-content"
        position={position}
        sideOffset={6}
        className={cn(
          'bg-popover text-popover-foreground animate-in fade-in-0 zoom-in-95 relative z-50 max-h-80 min-w-44 overflow-hidden rounded-lg border shadow-lg',
          className,
        )}
        {...props}
      >
        <SelectPrimitive.Viewport className="p-1">{children}</SelectPrimitive.Viewport>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  );
}

/** Heading inside a select menu (Radix's own Label must sit in a Group; this works anywhere). */
function SelectLabel({ className, ...props }: React.ComponentProps<'div'>) {
  return <div role="presentation" className={cn('text-muted-foreground px-2 py-1 text-[11px]', className)} {...props} />;
}

function SelectItem({ className, children, hint, ...props }: React.ComponentProps<typeof SelectPrimitive.Item> & { hint?: string }) {
  return (
    <SelectPrimitive.Item
      data-slot="select-item"
      className={cn(
        'focus:bg-accent focus:text-accent-foreground relative flex w-full cursor-pointer items-start gap-2 rounded-md py-1.5 pr-7 pl-2 text-[12.5px] outline-none select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
        className,
      )}
      {...props}
    >
      <span className="flex flex-col">
        <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
        {hint && <span className="text-muted-foreground text-[11px]">{hint}</span>}
      </span>
      <span className="absolute top-2 right-2 flex size-3.5 items-center justify-center">
        <SelectPrimitive.ItemIndicator>
          <Check className="size-3.5" />
        </SelectPrimitive.ItemIndicator>
      </span>
    </SelectPrimitive.Item>
  );
}

function SelectSeparator({ className, ...props }: React.ComponentProps<typeof SelectPrimitive.Separator>) {
  return <SelectPrimitive.Separator className={cn('bg-border -mx-1 my-1 h-px', className)} {...props} />;
}

export { Select, SelectContent, SelectItem, SelectLabel, SelectSeparator, SelectTrigger, SelectValue };
