"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { toastError, toastSuccess } from "@/components/Toast";
import Image from "next/image";
import { MutedText } from "@/components/Typography";
import { getAccountLinkingUrl } from "@/utils/account-linking";
import { isGoogleProvider } from "@/utils/email/provider-types";
import { env } from "@/env";
import type { PostValidateImapResponse } from "@/app/api/imap/linking/validate/route";
import type { PostConnectImapResponse } from "@/app/api/imap/linking/connect/route";

const DEFAULT_IMAP_FORM = {
  email: "",
  imapHost: "",
  imapPort: "993",
  smtpHost: "",
  smtpPort: "587",
  username: "",
  password: "",
};

function ImapForm({ onSuccess }: { onSuccess: () => void }) {
  const [form, setForm] = useState(DEFAULT_IMAP_FORM);
  const [isValidating, setIsValidating] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [validateError, setValidateError] = useState<string | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [validated, setValidated] = useState(false);

  const handleChange = (field: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setForm((prev) => ({ ...prev, [field]: e.target.value }));
    setValidated(false);
    setValidateError(null);
    setConnectError(null);
  };

  const handleValidate = async () => {
    setIsValidating(true);
    setValidateError(null);
    setValidated(false);

    try {
      const res = await fetch("/api/imap/linking/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const data: PostValidateImapResponse | { error: string } = await res.json();

      if (!res.ok || "error" in data) {
        setValidateError(
          "error" in data ? data.error : "Connection test failed",
        );
      } else {
        setValidated(true);
      }
    } catch {
      setValidateError("Network error — please try again");
    } finally {
      setIsValidating(false);
    }
  };

  const handleConnect = async () => {
    setIsConnecting(true);
    setConnectError(null);

    try {
      const res = await fetch("/api/imap/linking/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const data: PostConnectImapResponse | { error: string } = await res.json();

      if (!res.ok || "error" in data) {
        setConnectError(
          "error" in data ? data.error : "Failed to connect account",
        );
      } else {
        toastSuccess({ description: "IMAP account connected successfully" });
        onSuccess();
      }
    } catch {
      setConnectError("Network error — please try again");
    } finally {
      setIsConnecting(false);
    }
  };

  return (
    <div className="grid gap-4">
      <div className="grid gap-2">
        <Label htmlFor="imap-email">Email address</Label>
        <Input
          id="imap-email"
          type="email"
          placeholder="you@example.com"
          value={form.email}
          onChange={handleChange("email")}
          autoComplete="email"
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="grid gap-2">
          <Label htmlFor="imap-host">IMAP host</Label>
          <Input
            id="imap-host"
            placeholder="imap.example.com"
            value={form.imapHost}
            onChange={handleChange("imapHost")}
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="imap-port">IMAP port</Label>
          <Input
            id="imap-port"
            type="number"
            placeholder="993"
            value={form.imapPort}
            onChange={handleChange("imapPort")}
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="grid gap-2">
          <Label htmlFor="smtp-host">SMTP host</Label>
          <Input
            id="smtp-host"
            placeholder="smtp.example.com"
            value={form.smtpHost}
            onChange={handleChange("smtpHost")}
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="smtp-port">SMTP port</Label>
          <Input
            id="smtp-port"
            type="number"
            placeholder="587"
            value={form.smtpPort}
            onChange={handleChange("smtpPort")}
          />
        </div>
      </div>

      <div className="grid gap-2">
        <Label htmlFor="imap-username">Username</Label>
        <Input
          id="imap-username"
          placeholder="you@example.com"
          value={form.username}
          onChange={handleChange("username")}
          autoComplete="username"
        />
      </div>

      <div className="grid gap-2">
        <Label htmlFor="imap-password">Password / App password</Label>
        <Input
          id="imap-password"
          type="password"
          placeholder="••••••••"
          value={form.password}
          onChange={handleChange("password")}
          autoComplete="current-password"
        />
      </div>

      {validateError && (
        <p className="text-sm text-destructive">{validateError}</p>
      )}
      {connectError && (
        <p className="text-sm text-destructive">{connectError}</p>
      )}
      {validated && !validateError && (
        <p className="text-sm text-green-600">Connection test passed</p>
      )}

      <div className="flex gap-2">
        <Button
          variant="outline"
          onClick={handleValidate}
          loading={isValidating}
          disabled={isValidating || isConnecting}
          className="flex-1"
        >
          Test connection
        </Button>
        <Button
          onClick={handleConnect}
          loading={isConnecting}
          disabled={isConnecting || isValidating}
          className="flex-1"
        >
          Connect
        </Button>
      </div>
    </div>
  );
}

export function AddAccount() {
  const [isLoadingGoogle, setIsLoadingGoogle] = useState(false);
  const [isLoadingMicrosoft, setIsLoadingMicrosoft] = useState(false);
  const [imapDialogOpen, setImapDialogOpen] = useState(false);

  const handleAddAccount = async (provider: "google" | "microsoft") => {
    const setLoading = isGoogleProvider(provider)
      ? setIsLoadingGoogle
      : setIsLoadingMicrosoft;
    setLoading(true);

    try {
      const url = await getAccountLinkingUrl(provider);
      window.location.href = url;
    } catch (error) {
      console.error(`Error initiating ${provider} link:`, error);
      toastError({
        title: `Error initiating ${isGoogleProvider(provider) ? "Google" : "Microsoft"} link`,
        description: "Please try again or contact support",
      });
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-col items-center justify-center gap-3 min-h-[90px]">
      <div className="flex items-center gap-2 flex-wrap justify-center">
        <Button
          variant="outline"
          className="w-full"
          onClick={() => handleAddAccount("google")}
          loading={isLoadingGoogle}
          disabled={isLoadingGoogle || isLoadingMicrosoft}
        >
          <Image
            src="/images/google.svg"
            alt=""
            width={24}
            height={24}
            unoptimized
          />
          <span className="ml-2">Add Google</span>
        </Button>
        <Button
          variant="outline"
          className="w-full"
          onClick={() => handleAddAccount("microsoft")}
          loading={isLoadingMicrosoft}
          disabled={isLoadingGoogle || isLoadingMicrosoft}
        >
          <Image
            src="/images/microsoft.svg"
            alt=""
            width={24}
            height={24}
            unoptimized
          />
          <span className="ml-2">Add Microsoft</span>
        </Button>

        {env.NEXT_PUBLIC_IMAP_ENABLED && (
          <Dialog open={imapDialogOpen} onOpenChange={setImapDialogOpen}>
            <DialogTrigger asChild>
              <Button
                variant="outline"
                className="w-full"
                disabled={isLoadingGoogle || isLoadingMicrosoft}
              >
                <span>Add IMAP Server</span>
              </Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-md">
              <DialogHeader>
                <DialogTitle>Connect IMAP account</DialogTitle>
              </DialogHeader>
              <ImapForm onSuccess={() => setImapDialogOpen(false)} />
            </DialogContent>
          </Dialog>
        )}
      </div>

      <MutedText>You will be billed for each account.</MutedText>
    </div>
  );
}
