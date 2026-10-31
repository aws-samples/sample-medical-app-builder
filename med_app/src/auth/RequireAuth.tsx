import type { ReactNode } from 'react';
import { Center, Loader } from '@mantine/core';
import { useAuth } from './AuthContext';
import { SignInScreen } from './SignInScreen';
import type { RuntimeConfig } from '../config/env';

export function RequireAuth({ config, children }: { config: RuntimeConfig; children: ReactNode }) {
  const { status } = useAuth();
  if (status === 'restoring') {
    return (
      <Center h="100vh">
        <Loader />
      </Center>
    );
  }
  if (status === 'signed_out') {
    return <SignInScreen config={config} />;
  }
  return <>{children}</>;
}
