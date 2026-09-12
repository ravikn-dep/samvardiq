import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { LoginPage } from '../../src/pages/LoginPage.js';

const { signInMock } = vi.hoisted(() => ({ signInMock: vi.fn() }));
vi.mock('../../src/auth/AuthContext.js', () => ({ useAuth: () => ({ signIn: signInMock, signOut: vi.fn(), state: { status: 'unauthenticated' } }) }));

describe('LoginPage', () => {
  beforeEach(() => signInMock.mockReset());

  it('has labeled, keyboard-accessible email/password fields', () => {
    render(<LoginPage />);
    expect(screen.getByLabelText('Email')).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /sign in/i })).toBeEnabled();
  });

  it('U: a valid submission calls signIn with the entered credentials', async () => {
    signInMock.mockResolvedValue({});
    const user = userEvent.setup();
    render(<LoginPage />);

    await user.type(screen.getByLabelText('Email'), 'doctor@example.com');
    await user.type(screen.getByLabelText('Password'), 'correct-password');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    expect(signInMock).toHaveBeenCalledWith('doctor@example.com', 'correct-password');
  });

  it('V: an invalid submission shows a generic error and never the raw provider error', async () => {
    signInMock.mockResolvedValue({ error: 'Invalid email or password.' });
    const user = userEvent.setup();
    render(<LoginPage />);

    await user.type(screen.getByLabelText('Email'), 'doctor@example.com');
    await user.type(screen.getByLabelText('Password'), 'wrong');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid email or password.');
  });

  it('disables the submit button and shows a loading label while authenticating', async () => {
    let resolveSignIn: (value: { error?: string }) => void = () => {};
    signInMock.mockReturnValue(new Promise((resolve) => (resolveSignIn = resolve)));
    const user = userEvent.setup();
    render(<LoginPage />);

    await user.type(screen.getByLabelText('Email'), 'a@b.com');
    await user.type(screen.getByLabelText('Password'), 'pw');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    expect(screen.getByRole('button', { name: /signing in/i })).toBeDisabled();
    resolveSignIn({});
    await waitFor(() => expect(screen.queryByRole('button', { name: /signing in/i })).not.toBeInTheDocument());
  });
});
