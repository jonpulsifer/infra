'use client';

import { Info, Loader2, Plus, Send, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { sendOutgoingWebhookAction } from '@/lib/actions';
import {
  bodyFromJson,
  bodyPairsToJson,
  buildRequest,
  draftFromWebhook,
  emptyDraft,
  emptyPair,
  type FieldMode,
  type FieldPair,
  headersFromJson,
  METHODS,
  METHODS_WITH_BODY,
  pairsToJson,
  type RequestDraft,
} from '@/lib/request-draft';
import type { Webhook } from '@/lib/types';

/**
 * The compose-and-send form. All of the pairs/raw-JSON conversion and the
 * decision about what actually goes on the wire live in `lib/request-draft`;
 * this module holds the draft and renders it.
 *
 * There is one send path. It goes through `sendOutgoingWebhookAction`, which
 * enforces the domain allowlist and resolved-IP checks and records the result.
 */

interface OutgoingWebhookProps {
  projectSlug: string;
  webhookToResend?: Webhook | null;
  onResendComplete?: () => void;
  onWebhookSent?: () => void;
}

export function OutgoingWebhook({
  projectSlug,
  webhookToResend,
  onResendComplete,
  onWebhookSent,
}: OutgoingWebhookProps) {
  const [draft, setDraft] = useState<RequestDraft>(emptyDraft);
  const [isSending, setIsSending] = useState(false);

  const patch = (changes: Partial<RequestDraft>) =>
    setDraft((current) => ({ ...current, ...changes }));

  useEffect(() => {
    if (webhookToResend) {
      setDraft(draftFromWebhook(webhookToResend));
    }
  }, [webhookToResend]);

  const setPairs = (field: 'headerPairs' | 'bodyPairs', pairs: FieldPair[]) =>
    patch({ [field]: pairs } as Partial<RequestDraft>);

  const updatePair = (
    field: 'headerPairs' | 'bodyPairs',
    id: string,
    key: 'key' | 'value',
    value: string,
  ) =>
    setPairs(
      field,
      draft[field].map((pair) =>
        pair.id === id ? { ...pair, [key]: value } : pair,
      ),
    );

  const addPair = (field: 'headerPairs' | 'bodyPairs', prefix: string) =>
    setPairs(field, [...draft[field], emptyPair(prefix, Date.now())]);

  const removePair = (
    field: 'headerPairs' | 'bodyPairs',
    prefix: string,
    id: string,
  ) => {
    const remaining = draft[field].filter((pair) => pair.id !== id);
    setPairs(field, remaining.length > 0 ? remaining : [emptyPair(prefix)]);
  };

  const switchHeaderMode = (mode: FieldMode) => {
    if (mode === 'raw') {
      patch({ headerMode: 'raw', rawHeaders: pairsToJson(draft.headerPairs) });
      return;
    }
    const result = headersFromJson(draft.rawHeaders);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    patch({ headerMode: 'pairs', headerPairs: result.value });
  };

  const switchBodyMode = (mode: FieldMode) => {
    if (mode === 'raw') {
      patch({ bodyMode: 'raw', rawBody: bodyPairsToJson(draft.bodyPairs) });
      return;
    }
    const result = bodyFromJson(draft.rawBody);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    patch({ bodyMode: 'pairs', bodyPairs: result.value });
  };

  const handleSend = async () => {
    const request = buildRequest(draft);
    if (!request.ok) {
      toast.error(request.error);
      return;
    }

    setIsSending(true);
    try {
      const result = await sendOutgoingWebhookAction(
        projectSlug,
        request.value,
      );
      toast.success(
        `Webhook sent! Status: ${result.status} ${result.statusText}`,
        { description: result.responseBody?.slice(0, 100) },
      );
      onResendComplete?.();
      onWebhookSent?.();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Failed to send webhook',
      );
    } finally {
      setIsSending(false);
    }
  };

  const showBody = METHODS_WITH_BODY.has(draft.method.toUpperCase());

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="method">HTTP Method</Label>
          <Select
            value={draft.method}
            onValueChange={(method) => patch({ method })}
          >
            <SelectTrigger id="method" className="font-mono">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {METHODS.map((method) => (
                <SelectItem key={method} value={method}>
                  {method}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="url">Target URL</Label>
          <Input
            id="url"
            type="url"
            placeholder="https://example.com/webhook"
            value={draft.url}
            onChange={(e) => patch({ url: e.target.value })}
            className="font-mono"
          />
        </div>
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Label>Headers (optional)</Label>
            <TooltipProvider delayDuration={200}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Info className="h-4 w-4 text-muted-foreground" />
                </TooltipTrigger>
                <TooltipContent className="max-w-xs">
                  <p className="text-xs">
                    Use Raw JSON to send non-string header values (bools/ints).
                    To switch back to Fields, the JSON must be an object with
                    string values.
                  </p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
          <Tabs
            value={draft.headerMode}
            onValueChange={(mode) => switchHeaderMode(mode as FieldMode)}
            className="h-8"
          >
            <TabsList className="grid grid-cols-2 h-8">
              <TabsTrigger value="pairs" className="text-xs">
                Fields
              </TabsTrigger>
              <TabsTrigger value="raw" className="text-xs">
                Raw JSON
              </TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
        {draft.headerMode === 'pairs' ? (
          <div className="space-y-2">
            {draft.headerPairs.map((header) => (
              <div key={header.id} className="flex gap-2">
                <Input
                  placeholder="Header name"
                  value={header.key}
                  onChange={(e) =>
                    updatePair('headerPairs', header.id, 'key', e.target.value)
                  }
                  className="font-mono min-w-0"
                />
                <Input
                  placeholder="Header value"
                  value={header.value}
                  onChange={(e) =>
                    updatePair(
                      'headerPairs',
                      header.id,
                      'value',
                      e.target.value,
                    )
                  }
                  className="font-mono min-w-0"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  onClick={() => removePair('headerPairs', 'header', header.id)}
                  className="shrink-0"
                  disabled={draft.headerPairs.length === 1}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            ))}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => addPair('headerPairs', 'header')}
              className="h-7 gap-1"
            >
              <Plus className="h-3 w-3" />
              Add Header
            </Button>
          </div>
        ) : (
          <Textarea
            value={draft.rawHeaders}
            onChange={(e) => patch({ rawHeaders: e.target.value })}
            className="font-mono min-h-[140px]"
            placeholder='{"Authorization":"Bearer token"}'
          />
        )}
      </div>

      {showBody && (
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Label>Body JSON (optional)</Label>
              <TooltipProvider delayDuration={200}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Info className="h-4 w-4 text-muted-foreground" />
                  </TooltipTrigger>
                  <TooltipContent className="max-w-xs">
                    <p className="text-xs">
                      Fields mode builds a JSON object; each value is parsed as
                      JSON when it can be, and kept as a string when it cannot.
                      Use Raw JSON for arrays or non-object payloads.
                    </p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </div>
            <Tabs
              value={draft.bodyMode}
              onValueChange={(mode) => switchBodyMode(mode as FieldMode)}
              className="h-8"
            >
              <TabsList className="grid grid-cols-2 h-8">
                <TabsTrigger value="pairs" className="text-xs">
                  Fields
                </TabsTrigger>
                <TabsTrigger value="raw" className="text-xs">
                  Raw JSON
                </TabsTrigger>
              </TabsList>
            </Tabs>
          </div>
          {draft.bodyMode === 'pairs' ? (
            <div className="space-y-2">
              {draft.bodyPairs.map((pair) => (
                <div key={pair.id} className="flex gap-2">
                  <Input
                    placeholder="Key"
                    value={pair.key}
                    onChange={(e) =>
                      updatePair('bodyPairs', pair.id, 'key', e.target.value)
                    }
                    className="font-mono min-w-0"
                  />
                  <Input
                    placeholder="Value (JSON or string)"
                    value={pair.value}
                    onChange={(e) =>
                      updatePair('bodyPairs', pair.id, 'value', e.target.value)
                    }
                    className="font-mono min-w-0"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    onClick={() => removePair('bodyPairs', 'body', pair.id)}
                    className="shrink-0"
                    disabled={draft.bodyPairs.length === 1}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => addPair('bodyPairs', 'body')}
                className="h-7 gap-1"
              >
                <Plus className="h-3 w-3" />
                Add Field
              </Button>
            </div>
          ) : (
            <Textarea
              value={draft.rawBody}
              onChange={(e) => patch({ rawBody: e.target.value })}
              className="font-mono min-h-[180px]"
              placeholder='{"hello":"world"}'
            />
          )}
        </div>
      )}

      <Button
        onClick={handleSend}
        disabled={isSending || !draft.url.trim()}
        className="w-full bg-primary hover:bg-primary/90"
      >
        {isSending ? (
          <>
            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            Sending...
          </>
        ) : (
          <>
            <Send className="h-4 w-4 mr-2" />
            Send Webhook
          </>
        )}
      </Button>
    </div>
  );
}
