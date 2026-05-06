'use client';

import { useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import type { Role, UserStatus } from '@/lib/api';
import { revokeAllSessionsAction, updateUserAction } from './actions';

interface Props {
  userId: string;
  currentStatus: UserStatus;
  currentRole: Role;
  // True when the page is rendered for the logged-in admin themselves —
  // the role <select> is locked so they can't accidentally demote themselves.
  isSelf: boolean;
}

export function UserControls(props: Props) {
  const [status, setStatus] = useState<UserStatus>(props.currentStatus);
  const [role, setRole] = useState<Role>(props.currentRole);
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [, startTransition] = useTransition();
  const [pending, setPending] = useState<'save' | 'revoke' | null>(null);

  const dirty = status !== props.currentStatus || role !== props.currentRole;

  function save() {
    setMessage(null);
    setPending('save');
    startTransition(async () => {
      const patch: { status?: UserStatus; role?: Role } = {};
      if (status !== props.currentStatus) patch.status = status;
      if (role !== props.currentRole) patch.role = role;
      const result = await updateUserAction(props.userId, patch);
      setPending(null);
      if (!result.ok) setMessage({ tone: 'error', text: result.error ?? 'Update failed.' });
      else setMessage({ tone: 'ok', text: 'Saved.' });
    });
  }

  function revoke() {
    setMessage(null);
    setPending('revoke');
    startTransition(async () => {
      const result = await revokeAllSessionsAction(props.userId);
      setPending(null);
      if (!result.ok) setMessage({ tone: 'error', text: result.error ?? 'Revoke failed.' });
      else setMessage({ tone: 'ok', text: 'All sessions revoked.' });
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <div className="flex flex-col gap-1">
          <label className="text-xs uppercase tracking-wide text-slate-500">Status</label>
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value as UserStatus)}
            className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm"
          >
            <option value="ACTIVE">ACTIVE</option>
            <option value="PENDING">PENDING</option>
            <option value="DISABLED">DISABLED</option>
            <option value="LOCKED">LOCKED</option>
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs uppercase tracking-wide text-slate-500">Role</label>
          <select
            value={role}
            onChange={(e) => setRole(e.target.value as Role)}
            disabled={props.isSelf}
            title={props.isSelf ? 'Admins cannot change their own role.' : undefined}
            className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm disabled:cursor-not-allowed disabled:bg-slate-100"
          >
            <option value="USER">USER</option>
            <option value="ADMIN">ADMIN</option>
          </select>
          {props.isSelf && <p className="text-xs text-slate-500">You cannot change your own role.</p>}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button variant="accent" onClick={save} disabled={!dirty || pending === 'save'}>
          {pending === 'save' ? 'Saving…' : 'Save changes'}
        </Button>
        <Button variant="outline" onClick={revoke} disabled={pending === 'revoke'}>
          {pending === 'revoke' ? 'Revoking…' : 'Revoke all sessions'}
        </Button>
        {message && (
          <p className={message.tone === 'ok' ? 'text-sm text-emerald-600' : 'text-sm text-red-600'}>
            {message.text}
          </p>
        )}
      </div>
    </div>
  );
}
