import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router';
import { CampoTexto } from '../components/form';
import { Aviso, Boton } from '../components/ui';
import { ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';

export function LoginPage() {
  const { ready, user, login } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  if (ready && user) return <Navigate to="/" replace />;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSending(true);

    try {
      await login(email.trim(), password);
      void navigate('/', { replace: true });
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'no se pudo entrar en la consola');
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="flex min-h-dvh items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <p className="font-data text-[13px] tracking-[0.22em] text-hazard-ink uppercase">
          Centinela
        </p>
        <h1 className="mt-3 font-display text-[26px] leading-tight">Consola de operador</h1>
        <p className="mt-2 font-data text-[13px] text-ink-dim">
          Acceso reservado. La vigilancia y los avisos siguen en marcha aunque estés fuera.
        </p>

        <form onSubmit={handleSubmit} className="mt-8 space-y-4 border border-line p-5" noValidate>
          {error ? <Aviso tono="error">{error}</Aviso> : null}

          <CampoTexto
            etiqueta="Correo"
            type="email"
            name="email"
            autoComplete="username"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />

          <CampoTexto
            etiqueta="Contraseña"
            type="password"
            name="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />

          <Boton
            type="submit"
            variant="primario"
            className="w-full"
            disabled={sending || email.trim() === '' || password === ''}
          >
            {sending ? 'Entrando…' : 'Entrar'}
          </Boton>
        </form>

        <p className="mt-4 font-data text-[12px] text-ink-dim">
          ¿Sin acceso? Quien administre tu espacio puede darte una cuenta.
        </p>
      </div>
    </div>
  );
}
