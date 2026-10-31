import { MantineProvider } from '@mantine/core';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import { AuthProviderBoundary, useAuth } from '../auth/AuthContext';
import { SignInScreen } from '../auth/SignInScreen';
import { recoveryError } from '../auth/cognito';
import { AuthError, type AuthProvider, type Session } from '../auth/types';
import { testConfig } from './testUtils';
import { theme } from '../theme';

/**
 * "I forgot my password": from the sign-in form, a code is sent to the account's email, the code and a new
 * password set it, and the person is signed in with it — without a second trip through the form. Wrong codes
 * and accounts that were never activated get an explanation, not a Cognito exception name.
 */

const session: Session = { idToken: 't', accessToken: 'a', expiresAt: Math.floor(Date.now() / 1000) + 3600, claims: { sub: 'u1', username: 'u1', email: 'you@example.org', groups: [] } };

function fakeProvider(options: { confirmFails?: Error; forgotFails?: Error } = {}) {
  const calls: { forgot: string[]; confirm: [string, string, string][]; signIn: [string, string][] } = { forgot: [], confirm: [], signIn: [] };
  const provider: AuthProvider = {
    kind: 'cognito',
    restoreSession: async () => null,
    signIn: async (username, password) => {
      calls.signIn.push([username, password]);
      return { status: 'signed_in', session };
    },
    signOut: async () => {},
    forgotPassword: async (username) => {
      calls.forgot.push(username);
      if (options.forgotFails) throw options.forgotFails;
      return { destination: 'b***@example.org' };
    },
    confirmForgotPassword: async (username, code, newPassword) => {
      calls.confirm.push([username, code, newPassword]);
      if (options.confirmFails) throw options.confirmFails;
    },
  };
  return { provider, calls };
}

function Status() {
  const { status, session: s } = useAuth();
  return <div data-testid="status">{status}:{s?.claims.email ?? '-'}</div>;
}

function renderScreen(provider: AuthProvider) {
  return render(
    <MantineProvider theme={theme}>
      <AuthProviderBoundary provider={provider}>
        <Status />
        <SignInScreen config={{ ...testConfig, auth: { ...testConfig.auth, mode: 'cognito' } }} />
      </AuthProviderBoundary>
    </MantineProvider>
  );
}

describe('password recovery from the sign-in screen', () => {
  test('forgot → code emailed → new password set → signed in with it', async () => {
    const { provider, calls } = fakeProvider();
    renderScreen(provider);
    await screen.findByText('signed_out:-');

    fireEvent.change(screen.getByLabelText(/Email/), { target: { value: 'you@example.org' } });
    fireEvent.click(screen.getByTestId('forgot-password'));
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Reset your password');
    expect(screen.getByLabelText(/Email/)).toHaveValue('you@example.org'); // carried over, not typed twice
    fireEvent.click(screen.getByRole('button', { name: 'Send code' }));

    await screen.findByText('Enter the code');
    expect(calls.forgot).toEqual(['you@example.org']);
    expect(screen.getByTestId('signin-subtitle')).toHaveTextContent('We sent a code to b***@example.org');

    fireEvent.change(screen.getByLabelText(/^Code/), { target: { value: ' 482913 ' } });
    fireEvent.change(screen.getByLabelText(/New password/), { target: { value: 'Correct-Horse-Battery-9' } });
    fireEvent.click(screen.getByRole('button', { name: 'Set new password and sign in' }));

    await screen.findByText('signed_in:you@example.org');
    expect(calls.confirm).toEqual([['you@example.org', ' 482913 ', 'Correct-Horse-Battery-9']]);
    expect(calls.signIn).toEqual([['you@example.org', 'Correct-Horse-Battery-9']]);
  });

  test('a wrong code keeps the person on the code step with an explanation, and a new code can be requested', async () => {
    const { provider, calls } = fakeProvider({ confirmFails: recoveryError({ code: 'CodeMismatchException', message: 'Invalid verification code provided, please try again.' }, 'x') });
    renderScreen(provider);
    await screen.findByText('signed_out:-');
    fireEvent.change(screen.getByLabelText(/Email/), { target: { value: 'you@example.org' } });
    fireEvent.click(screen.getByTestId('forgot-password'));
    fireEvent.click(screen.getByRole('button', { name: 'Send code' }));
    await screen.findByText('Enter the code');

    fireEvent.change(screen.getByLabelText(/^Code/), { target: { value: '000000' } });
    fireEvent.change(screen.getByLabelText(/New password/), { target: { value: 'Correct-Horse-Battery-9' } });
    fireEvent.click(screen.getByRole('button', { name: 'Set new password and sign in' }));
    await waitFor(() => expect(screen.getByTestId('signin-error')).toHaveTextContent('That code is not right.'));
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Enter the code');
    expect(calls.signIn).toEqual([]); // never signed in with an unset password

    fireEvent.click(screen.getByTestId('resend-code'));
    await waitFor(() => expect(calls.forgot).toHaveLength(2));
    fireEvent.click(screen.getByTestId('back-to-sign-in'));
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Sign in');
  });

  test('an account that never completed its first sign-in is told to ask for a new invitation', async () => {
    const stuck = recoveryError({ code: 'NotAuthorizedException', message: 'User password cannot be reset in the current state.' }, 'x');
    const { provider } = fakeProvider({ forgotFails: stuck });
    renderScreen(provider);
    await screen.findByText('signed_out:-');
    fireEvent.click(screen.getByTestId('forgot-password'));
    fireEvent.change(screen.getByLabelText(/Email/), { target: { value: 'new.user@example.org' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send code' }));
    await waitFor(() => expect(screen.getByTestId('signin-error')).toHaveTextContent('has not been activated yet'));
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Reset your password');
  });

  test("Cognito's recovery errors become instructions", () => {
    expect(recoveryError({ code: 'ExpiredCodeException', message: 'Invalid code provided, please request a code again.' }, 'x').message).toMatch(/expired/);
    expect(recoveryError({ code: 'LimitExceededException', message: 'Attempt limit exceeded, please try after some time.' }, 'x').message).toMatch(/Too many attempts/);
    expect(recoveryError({ code: 'InvalidPasswordException', message: 'Password did not conform with policy' }, 'x').message).toMatch(/12 characters/);
    expect(recoveryError({ code: 'InvalidParameterException', message: 'Cannot reset password for the user as there is no registered/verified email or phone_number' }, 'x').message).toMatch(/no verified email/);
    expect(recoveryError({ code: 'UserNotFoundException', message: 'Username/client id combination not found.' }, 'x').message).toMatch(/If an account exists/);
    const unknown = recoveryError({ code: 'SomethingElse', message: 'as the server said' }, 'fallback');
    expect(unknown).toBeInstanceOf(AuthError);
    expect(unknown.message).toBe('as the server said');
    expect(recoveryError({}, 'fallback').message).toBe('fallback');
  });
});
