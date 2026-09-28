import type { ComponentProps, ElementType, FC } from 'react'
import { memo } from 'react'
import { Streamdown } from 'streamdown'

import { extractAlert, MarkdownAlert } from '@/components/assistant-ui/embeds/alert'
import { ExternalLink } from '@/lib/external-link'
import { cn } from '@/lib/utils'

// Compact markdown renderer for tool detail bodies. Same Streamdown pipeline
// as the file preview pane, with tighter typography and external-link routing
// so tools that emit markdown (tables, headings, links) render properly
// instead of being dumped as raw text.

const TAG_CLASSES = {
  blockquote: 'mt-2 mb-2 border-l-2 border-(--ui-stroke-tertiary) pl-2.5 italic text-muted-foreground/85',
  h1: 'mt-3 mb-1.5 text-sm font-semibold tracking-tight text-foreground first:mt-0',
  h2: 'mt-3 mb-1.5 text-[0.82rem] font-semibold tracking-tight text-foreground first:mt-0',
  h3: 'mt-2.5 mb-1 text-[0.78rem] font-semibold text-foreground first:mt-0',
  h4: 'mt-2 mb-1 text-[0.74rem] font-semibold text-foreground first:mt-0',
  hr: 'my-2 border-(--ui-stroke-tertiary)',
  li: 'marker:text-muted-foreground/60',
  ol: 'mb-2 list-decimal pl-5 last:mb-0',
  // `whitespace-pre-wrap` keeps single newlines and leading indentation that
  // markdown would otherwise collapse into a space (soft breaks). Without it a
  // plain-text tree / indented list pasted into a room line renders as one long
  // line — the room reported exactly that on 2026-09-21 (steward's ASCII tree).
  p: 'mb-1.5 leading-relaxed whitespace-pre-wrap last:mb-0',
  pre: 'mb-2 overflow-x-auto rounded-md border border-(--ui-stroke-tertiary) bg-background/70 p-2 font-mono text-[0.7rem] leading-[1.55] last:mb-0',
  td: 'px-2 py-1 align-top leading-snug',
  th: 'px-2 py-1 text-left text-[0.62rem] font-semibold uppercase tracking-[0.08em] text-muted-foreground/80',
  thead: 'bg-muted/40',
  ul: 'mb-2 list-disc pl-5 last:mb-0'
} as const

function tagged<T extends keyof typeof TAG_CLASSES>(Tag: T) {
  const Component = (({ className, ...rest }: ComponentProps<T>) => {
    const Element = Tag as ElementType

    return <Element className={cn(TAG_CLASSES[Tag], className)} {...rest} />
  }) as FC<ComponentProps<T>>

  Component.displayName = `Md.${Tag}`

  return Component
}

function MarkdownAnchor({ children, className, href, ...rest }: ComponentProps<'a'>) {
  if (!href || !/^https?:\/\//i.test(href)) {
    return (
      <a className={cn('ref', className)} href={href} {...rest}>
        {children}
      </a>
    )
  }

  return (
    <ExternalLink className={className} href={href}>
      {children}
    </ExternalLink>
  )
}

function MarkdownCode({ className, ...rest }: ComponentProps<'code'>) {
  return (
    <code
      className={cn('rounded bg-muted/80 px-1 py-px font-mono text-[0.86em] text-muted-foreground', className)}
      {...rest}
    />
  )
}

function MarkdownTable({ className, ...rest }: ComponentProps<'table'>) {
  return (
    <div className="mb-2 max-w-full overflow-x-auto rounded-md border border-(--ui-stroke-tertiary) last:mb-0">
      <table
        className={cn(
          'w-full border-collapse text-[0.72rem] [&_tr]:border-b [&_tr]:border-(--ui-stroke-tertiary) last:[&_tr]:border-0',
          className
        )}
        {...rest}
      />
    </div>
  )
}

// Room cards & tool bodies share this renderer, and both surface agent
// markdown that can carry GitHub-style alerts (`> [!BOOK]` quotes from 带读
// above all). Route marked blockquotes through MarkdownAlert so the marker
// doesn't leak as raw text; plain blockquotes keep the compact italic style.
const BlockquoteTag = tagged('blockquote')

function MarkdownBlockquote({ children, ...rest }: ComponentProps<'blockquote'>) {
  const alert = extractAlert(children)

  if (alert) {
    return <MarkdownAlert type={alert.type}>{alert.body}</MarkdownAlert>
  }

  return (
    <BlockquoteTag {...rest}>
      {children}
    </BlockquoteTag>
  )
}

const COMPONENTS = {
  a: MarkdownAnchor,
  blockquote: MarkdownBlockquote,
  code: MarkdownCode,
  h1: tagged('h1'),
  h2: tagged('h2'),
  h3: tagged('h3'),
  h4: tagged('h4'),
  hr: tagged('hr'),
  li: tagged('li'),
  ol: tagged('ol'),
  p: tagged('p'),
  pre: tagged('pre'),
  table: MarkdownTable,
  td: tagged('td'),
  th: tagged('th'),
  thead: tagged('thead'),
  ul: tagged('ul')
}

export const CompactMarkdown = memo(function CompactMarkdown({
  className,
  text
}: {
  className?: string
  text: string
}) {
  // Leading indentation of a plain-text tree (or any hand-indented block) is
  // eaten even with `whitespace-pre-wrap`: markdown trims line-leading spaces
  // before the CSS ever sees them, so `└─` under `   └─` loses its level and the
  // room reads "没有层级感" (2026-09-21). Converting runs of leading spaces to
  // non-breaking spaces keeps the level visible without switching to <pre>
  // (which would kill inline markdown and wrap differently).
  const withKeptIndent = text.replace(/^( +)/gm, indent => '\u00a0'.repeat(indent.length))

  return (
    <div className={cn('max-w-full text-xs leading-relaxed text-muted-foreground/90 wrap-anywhere', className)}>
      <Streamdown components={COMPONENTS} controls={false} mode="static" parseIncompleteMarkdown={false}>
        {withKeptIndent}
      </Streamdown>
    </div>
  )
})
