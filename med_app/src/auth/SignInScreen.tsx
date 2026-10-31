import { useState, type FormEvent } from 'react';
import { Alert, Anchor, Badge, Box, Button, Group, List, PasswordInput, Stack, Text, TextInput, Title } from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';
import { useAuth } from './AuthContext';
import { BuilderPanel } from './BuilderPanel';
import type { RuntimeConfig } from '../config/env';
import { tokens } from '../theme';

/** Human label for a Cognito attribute name the pool marks as required-but-missing. */
function attributeLabel(attr: string): string {
  const known: Record<string, string> = { given_name: 'First name', family_name: 'Last name', name: 'Full name', phone_number: 'Phone number', email: 'Email' };
  return known[attr] ?? attr.replace(/^custom:/, '').replace(/_/g, ' ');
}

const PASSWORD_RULES = 'At least 12 characters with upper and lower case, a digit and a symbol.';

/**
 * What the screen is doing. `sign_in` is the form; a pending challenge (first sign-in with a temporary
 * password) takes precedence over the mode; `forgot` asks which account, `reset` takes the emailed code
 * and the new password and then signs the person in with it — no second trip through the form.
 */
type Mode = 'sign_in' | 'forgot' | 'reset';

export function SignInScreen({ config }: { config: RuntimeConfig }) {
  const auth = useAuth();
  const [mode, setMode] = useState<Mode>('sign_in');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [code, setCode] = useState('');
  const [destination, setDestination] = useState<string | undefined>(undefined);
  const [requiredValues, setRequiredValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const misconfigured = config.auth.mode === 'cognito' && config.problems.length > 0;
  const challenge = auth.pendingChallenge;
  const mock = auth.providerKind === 'mock';

  function switchTo(next: Mode) {
    setMode(next);
    setError(null);
    setNotice(null);
    setCode('');
    setNewPassword('');
  }

  async function sendCode() {
    const sent = await auth.forgotPassword(username.trim());
    setDestination(sent.destination);
    setNotice(sent.destination ? `We sent a code to ${sent.destination}. It is valid for a short while.` : 'If an account exists for this address, a code has been sent to it.');
    setMode('reset');
    setCode('');
    setNewPassword('');
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (challenge) {
        await auth.completeNewPassword(newPassword, requiredValues);
      } else if (mode === 'forgot') {
        await sendCode();
      } else if (mode === 'reset') {
        await auth.confirmForgotPassword(username.trim(), code, newPassword);
        // The password is set; sign in with it rather than sending the person back to the form.
        await auth.signIn(username.trim(), newPassword);
      } else {
        await auth.signIn(username, password);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed.');
    } finally {
      setBusy(false);
    }
  }

  async function resendCode() {
    setError(null);
    setBusy(true);
    try {
      await sendCode();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send a new code.');
    } finally {
      setBusy(false);
    }
  }

  const title = challenge ? 'Choose a new password' : mode === 'forgot' ? 'Reset your password' : mode === 'reset' ? 'Enter the code' : 'Sign in';
  const subtitle = challenge
    ? `Your account (${challenge.username}) requires a new password before continuing.`
    : mode === 'forgot'
      ? 'Enter the email address of your hospital account. We will send a code to it.'
      : mode === 'reset'
        ? notice ?? 'Enter the code from the email and choose a new password.'
        : mock
          ? 'Any username and password are accepted. Add +viewer,reviewer to the username to hold those roles; +medapp-admins to administer.'
          : 'Use your hospital account.';
  const submitLabel = challenge ? 'Set password and continue' : mode === 'forgot' ? 'Send code' : mode === 'reset' ? 'Set new password and sign in' : 'Sign in';

  return (
    <Box className="signin" style={{ background: tokens.page }}>
      <BuilderPanel hospitalName={config.hospitalName} />

      <Box className="signin-form">
        <Stack className="signin-card" gap="lg">
          <div>
            <Group gap="sm" align="baseline">
              <Title order={1}>{title}</Title>
              {mock && (
                <Badge color="orange" variant="filled" tt="none">
                  Mock auth, dev only
                </Badge>
              )}
            </Group>
            <Text c="dimmed" size="sm" mt={4} data-testid="signin-subtitle">
              {subtitle}
            </Text>
          </div>

          {misconfigured && (
            <Alert color="red" icon={<IconAlertTriangle size={18} />} title="Sign-in is not configured">
              <Text size="sm">Fix the following in the .env file, then reload:</Text>
              <List size="sm" mt={4}>
                {config.problems.map((p) => (
                  <List.Item key={p}>{p}</List.Item>
                ))}
              </List>
            </Alert>
          )}

          <form onSubmit={onSubmit} data-mode={challenge ? 'challenge' : mode}>
            <Stack gap="md">
              {challenge ? (
                <>
                  <PasswordInput
                    label="New password"
                    description={PASSWORD_RULES}
                    required
                    autoFocus
                    autoComplete="new-password"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.currentTarget.value)}
                    disabled={busy}
                  />
                  {challenge.requiredAttributes.map((attr) => (
                    <TextInput
                      key={attr}
                      label={attributeLabel(attr)}
                      required
                      value={requiredValues[attr] ?? ''}
                      onChange={(e) => setRequiredValues((prev) => ({ ...prev, [attr]: e.currentTarget.value }))}
                      disabled={busy}
                    />
                  ))}
                </>
              ) : mode === 'forgot' ? (
                <TextInput
                  label="Email"
                  required
                  autoFocus
                  autoComplete="username"
                  value={username}
                  onChange={(e) => setUsername(e.currentTarget.value)}
                  disabled={busy || misconfigured}
                />
              ) : mode === 'reset' ? (
                <>
                  <TextInput
                    label="Code"
                    description={destination ? `From the email sent to ${destination}.` : 'From the email we sent you.'}
                    required
                    autoFocus
                    autoComplete="one-time-code"
                    inputMode="numeric"
                    value={code}
                    onChange={(e) => setCode(e.currentTarget.value)}
                    disabled={busy}
                  />
                  <PasswordInput
                    label="New password"
                    description={PASSWORD_RULES}
                    required
                    autoComplete="new-password"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.currentTarget.value)}
                    disabled={busy}
                  />
                </>
              ) : (
                <>
                  <TextInput
                    label="Email"
                    required
                    autoFocus
                    autoComplete="username"
                    value={username}
                    onChange={(e) => setUsername(e.currentTarget.value)}
                    disabled={busy || misconfigured}
                  />
                  <PasswordInput
                    label="Password"
                    required
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.currentTarget.value)}
                    disabled={busy || misconfigured}
                  />
                </>
              )}
              {error && (
                <Alert color="red" variant="light" data-testid="signin-error">
                  {error}
                </Alert>
              )}
              <Button type="submit" loading={busy} disabled={misconfigured} fullWidth size="md">
                {submitLabel}
              </Button>
              {!challenge && mode === 'sign_in' && (
                <Group justify="flex-end">
                  <Anchor component="button" type="button" size="sm" onClick={() => switchTo('forgot')} disabled={busy || misconfigured} data-testid="forgot-password">
                    Forgot your password?
                  </Anchor>
                </Group>
              )}
              {!challenge && mode === 'reset' && (
                <Group justify="space-between">
                  <Anchor component="button" type="button" size="sm" onClick={() => void resendCode()} disabled={busy} data-testid="resend-code">
                    Send a new code
                  </Anchor>
                  <Anchor component="button" type="button" size="sm" onClick={() => switchTo('sign_in')} disabled={busy} data-testid="back-to-sign-in">
                    Back to sign in
                  </Anchor>
                </Group>
              )}
              {!challenge && mode === 'forgot' && (
                <Group justify="flex-end">
                  <Anchor component="button" type="button" size="sm" onClick={() => switchTo('sign_in')} disabled={busy} data-testid="back-to-sign-in">
                    Back to sign in
                  </Anchor>
                </Group>
              )}
            </Stack>
          </form>

          <Text size="xs" c="dimmed">
            {mode === 'sign_in' && !challenge
              ? 'Access is granted by your hospital. If you cannot sign in, contact your administrator.'
              : 'An account that has never been signed in to cannot reset its own password: ask your administrator for a new invitation.'}
          </Text>
        </Stack>
      </Box>
    </Box>
  );
}
