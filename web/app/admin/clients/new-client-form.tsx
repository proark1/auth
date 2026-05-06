'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { createClientFormAction } from './actions';

export function NewClientForm() {
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <Button variant="accent" onClick={() => setOpen(true)}>
        New service client
      </Button>
    );
  }

  return (
    <form
      action={createClientFormAction}
      className="flex flex-col gap-3 rounded-md border border-slate-200 bg-white p-4"
    >
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <Field label="Name" required>
          <Input name="name" required placeholder="HR Service" />
        </Field>
        <Field label="Scopes (comma-separated)">
          <Input name="scopes" placeholder="hr:read, hr:write" />
        </Field>
        <Field label="From address">
          <Input name="fromAddress" type="email" placeholder="noreply@hr.example.com" />
        </Field>
        <Field label="Verify subject">
          <Input name="verifyEmailSubject" placeholder="Verify your HR account" />
        </Field>
        <Field label="Reset subject">
          <Input name="passwordResetSubject" placeholder="Reset your HR password" />
        </Field>
      </div>
      <div className="flex items-center gap-2">
        <Button type="submit" variant="accent">
          Create
        </Button>
        <Button type="button" variant="outline" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function Field({ label, children, required }: { label: string; children: React.ReactNode; required?: boolean }) {
  return (
    <div className="flex flex-col gap-1">
      <Label>
        {label}
        {required && <span className="ml-1 text-red-600">*</span>}
      </Label>
      {children}
    </div>
  );
}
