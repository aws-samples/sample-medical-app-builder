import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ActionIcon, Alert, Badge, Box, Button, Group, Loader, Paper, ScrollArea, SegmentedControl, SimpleGrid, Stack, Text, Textarea, Tooltip, UnstyledButton } from '@mantine/core';
import { IconDeviceFloppy, IconSend } from '@tabler/icons-react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { DraftView } from '../../authoring/types';
import { tokens } from '../../theme';
import { toolLabel } from './specView';
import { starterPrompts, type StarterLanguage, type StarterPrompt } from './starters';

/**
 * What the chat offers once the draft is complete: the real save, right where the conversation ends. The assistant
 * cannot save (nor submit, approve or publish — the prompt says so); the author does, with this button or the one in
 * the header, and the card says what follows. Absent while the draft is incomplete or already saved.
 */
export interface SaveHandoff {
  readonly label: string;
  readonly saving: boolean;
  readonly onSave: () => void;
  /** What saving means at this point: a first version, a new version, or changes to a draft version. */
  readonly note: string;
}

/**
 * The conversation with the drafting assistant. Assistant messages are Markdown (the agent writes
 * lists and code spans); the person's are plain text. While the agent works, the message that was
 * sent shows at once and the tools it runs appear as chips, so the wait is not blind.
 */
export function ChatPane({
  view,
  busy,
  disabledReason,
  onSend,
  handoff,
  iterating,
}: {
  view: DraftView;
  busy: boolean;
  /** Why the composer is disabled (saved drafts do not take messages); undefined = enabled. */
  disabledReason?: string;
  onSend: (message: string) => Promise<void>;
  handoff?: SaveHandoff;
  /** The app this draft iterates on, when it does — the empty transcript then sets the scene instead of asking for a description. */
  iterating?: { app_id: string; version: string; name?: string };
}) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  const turn = view.turn;
  const pendingUser = busy && turn ? turn.message : null;
  const failed = turn?.status === 'failed' ? turn : null;

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [view.transcript.length, busy, turn?.progress.length, handoff !== undefined]);

  async function send(message: string) {
    if (!message || busy || sending || disabledReason) return;
    setSending(true);
    try {
      await onSend(message);
      setText('');
    } finally {
      setSending(false);
    }
  }

  const submit = () => send(text.trim());

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  }

  return (
    <Stack gap={0} h="100%" style={{ minHeight: 0 }}>
      <ScrollArea style={{ flex: 1, minHeight: 0 }} type="auto" scrollbars="y" offsetScrollbars classNames={{ content: 'scroll-fill' }}>
        <Stack gap="sm" p="md" data-testid="transcript">
          {view.transcript.length === 0 && !pendingUser && (
            <Paper p="md" radius="md" style={{ background: tokens.page }} data-testid="chat-empty">
              {iterating ? (
                <Text size="sm" c="dimmed">
                  You are iterating on <b>{iterating.name ?? iterating.app_id}</b> (v{iterating.version}). The assistant knows the app as it stands: say what
                  should change, or ask it for suggestions. Your changes become a new version; the published app stays as it is until that version is
                  reviewed and published.
                </Text>
              ) : (
                <>
                  <Text size="sm" c="dimmed">
                    Describe the app in your own words: what it shows, for whom, about which patients. The assistant asks about anything that is unclear and
                    fills in the draft on the right as you go. Do not paste patient data here; a draft describes an app, not a person.
                  </Text>
                  <Starters onPick={(p) => void send(p.text)} disabled={busy || sending || Boolean(disabledReason)} />
                </>
              )}
            </Paper>
          )}
          {view.transcript.map((entry, i) => (
            <Bubble key={i} role={entry.role} text={entry.text} />
          ))}
          {pendingUser && (
            <>
              <Bubble role="user" text={pendingUser} />
              <Group gap="xs" pl="xs" align="center" data-testid="turn-progress">
                <Loader size="xs" type="dots" />
                <Text size="xs" c="dimmed">
                  {turn?.status === 'queued' ? 'Sending…' : 'Working…'}
                </Text>
                {turn?.progress.map((name, i) => (
                  <Badge key={`${name}-${i}`} size="xs" variant="light" color="ink" tt="none">
                    {toolLabel(name)}
                  </Badge>
                ))}
              </Group>
            </>
          )}
          {failed && (
            <Alert color="red" variant="light" title="The assistant could not answer" py="xs">
              <Text size="xs">{failed.error ?? 'Unknown error.'} Your message was not applied; you can send it again.</Text>
            </Alert>
          )}
          {handoff && !busy && (
            <Paper p="sm" radius="md" data-testid="chat-handoff" style={{ background: tokens.page, border: `1px solid var(--mantine-color-clinical-2)` }}>
              <Stack gap="xs">
                <Text size="sm">{handoff.note}</Text>
                <Group>
                  <Button size="xs" leftSection={<IconDeviceFloppy size={14} />} onClick={handoff.onSave} loading={handoff.saving} data-testid="chat-save">
                    {handoff.label}
                  </Button>
                </Group>
              </Stack>
            </Paper>
          )}
          <div ref={bottom} />
        </Stack>
      </ScrollArea>

      <Box p="md" style={{ borderTop: `1px solid ${tokens.line}` }}>
        <Group align="flex-end" gap="xs" wrap="nowrap">
          <Textarea
            aria-label="Message to the drafting assistant"
            placeholder={disabledReason ?? (busy ? 'The assistant is working…' : iterating && view.transcript.length === 0 ? 'What should change, or what would you like to know about this app?' : 'Describe the app, or answer the question above')}
            value={text}
            onChange={(e) => setText(e.currentTarget.value)}
            onKeyDown={onKeyDown}
            autosize
            minRows={1}
            maxRows={6}
            disabled={Boolean(disabledReason)}
            style={{ flex: 1 }}
          />
          <Tooltip label={disabledReason ?? 'Send (Enter)'}>
            <ActionIcon size="lg" variant="filled" onClick={() => void submit()} disabled={!text.trim() || busy || sending || Boolean(disabledReason)} aria-label="Send message">
              <IconSend size={16} />
            </ActionIcon>
          </Tooltip>
        </Group>
        <Text size="xs" c="dimmed" mt={4}>
          Enter sends, Shift+Enter for a new line.
        </Text>
      </Box>
    </Stack>
  );
}

/** The browser's language picks the starting language of the examples; the person can switch. */
function browserLanguage(): StarterLanguage {
  return typeof navigator !== 'undefined' && navigator.language?.toLowerCase().startsWith('de') ? 'de' : 'en';
}

/**
 * Requests to send with one click, for someone who does not yet know what to ask: four that show the breadth (a trend,
 * a designed form, an imaging cohort, a composed page), the rest behind "More ideas". The texts are the catalog's own
 * example requests, in English or German; sending one starts the conversation as typing it would.
 */
function Starters({ onPick, disabled }: { onPick: (p: StarterPrompt) => void; disabled: boolean }) {
  const [language, setLanguage] = useState<StarterLanguage>(browserLanguage);
  const [expanded, setExpanded] = useState(false);
  const { featured, more } = starterPrompts(language);
  const shown = expanded ? [...featured, ...more] : featured;
  return (
    <Stack gap="xs" mt="md" data-testid="starter-prompts">
      <Group justify="space-between" align="center">
        <Text size="xs" fw={600} c="dimmed" tt="uppercase" style={{ letterSpacing: '0.04em' }}>
          Or try one of these
        </Text>
        <SegmentedControl
          size="xs"
          value={language}
          onChange={(v) => setLanguage(v as StarterLanguage)}
          data={[
            { label: 'English', value: 'en' },
            { label: 'Deutsch', value: 'de' },
          ]}
          data-testid="starters-language"
        />
      </Group>
      <SimpleGrid cols={{ base: 1, md: 2 }} spacing="xs">
        {shown.map((p) => (
          <UnstyledButton
            key={p.archetype}
            onClick={() => onPick(p)}
            disabled={disabled}
            className="ds-press starter-card"
            data-testid={`starter-${p.archetype}`}
            style={{ display: 'block', padding: '10px 12px', borderRadius: 'var(--mantine-radius-md)', background: tokens.surface, border: `1px solid ${tokens.line}`, textAlign: 'left', opacity: disabled ? 0.6 : 1 }}
          >
            <Text size="sm" lh={1.4}>
              {p.text}
            </Text>
            <Text size="xs" c="dimmed" mt={4}>
              {p.kind}
            </Text>
          </UnstyledButton>
        ))}
      </SimpleGrid>
      {more.length > 0 && (
        <Button variant="subtle" color="gray" size="compact-xs" w="fit-content" onClick={() => setExpanded((e) => !e)} data-testid="starters-more">
          {expanded ? 'Fewer ideas' : `More ideas (${more.length})`}
        </Button>
      )}
    </Stack>
  );
}

function Bubble({ role, text }: { role: 'user' | 'assistant'; text: string }) {
  const mine = role === 'user';
  return (
    <Group justify={mine ? 'flex-end' : 'flex-start'} wrap="nowrap">
      <Paper
        p="sm"
        radius="md"
        maw="85%"
        data-testid={`message-${role}`}
        style={{
          background: mine ? 'var(--mantine-color-clinical-0)' : tokens.surface,
          border: `1px solid ${mine ? 'var(--mantine-color-clinical-2)' : tokens.line}`,
        }}
      >
        {mine ? (
          <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
            {text}
          </Text>
        ) : (
          <div className="chat-markdown">
            <Markdown remarkPlugins={[remarkGfm]}>{text}</Markdown>
          </div>
        )}
      </Paper>
    </Group>
  );
}
