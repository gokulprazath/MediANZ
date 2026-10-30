"use client";
// AI operations (Part B, B8): what the agent fleet did, which engines ran and
// whether they may receive health data, what is waiting for a human, and the
// web-research agent's drafts for staff approval. Counts, latency and ids
// only: agent logs never hold patient text, and nothing here shows any.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, Bot, ShieldCheck, ShieldOff } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Field } from "@/components/form-field";
import { NativeSelect } from "@/components/native-select";
import { EmptyState, PageHeader, QueryView } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { COVERAGE_LABEL } from "@/features/concierge/format";
import { agentErrorMessage, agents } from "@/lib/agents/client";
import { useApi } from "@/lib/data/context";
import { useLiveQuery } from "@/lib/hooks/use-live-query";
import { formatDateTime, userTimeZone } from "@/lib/time";

function Stat({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2 className="text-sm font-medium text-muted-foreground">{label}</h2>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-3xl font-semibold tabular-nums">{value}</p>
        {hint ? <p className="text-sm text-muted-foreground">{hint}</p> : null}
      </CardContent>
    </Card>
  );
}

function ResearchDrafts() {
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const query = useQuery({ queryKey: ["research-drafts"], queryFn: () => agents.researchDrafts("pending"), retry: false });
  const act = async (id: string, approve: boolean) => {
    setBusy(id);
    try {
      if (approve) await agents.approveResearchDraft(id);
      else await agents.rejectResearchDraft(id, null);
      await qc.invalidateQueries({ queryKey: ["research-drafts"] });
      toast.success(approve ? "Draft approved: it now informs cost estimates" : "Draft rejected");
    } catch (err) {
      toast.error(agentErrorMessage(err));
    } finally {
      setBusy(null);
    }
  };
  return (
    <Card role="region" aria-labelledby="research-title">
      <CardHeader>
        <CardTitle>
          <h2 id="research-title" className="text-lg">
            Insurance research drafts
          </h2>
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          The web-research agent reads insurer and clinic websites and drafts coverage rules. They are used for cost estimates only after staff approve them.
        </p>
      </CardHeader>
      <CardContent>
        {query.isError ? (
          <p className="text-sm text-muted-foreground">{agentErrorMessage(query.error)}</p>
        ) : (
          <QueryView query={query}>
            {(drafts) =>
              drafts.length === 0 ? (
                <EmptyState title="No drafts waiting" />
              ) : (
                <ul className="grid gap-3">
                  {drafts.map((d) => (
                    <li key={d.id} className="grid gap-2 rounded-lg border p-3 text-sm">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant="outline">{d.kind === "coverage" ? "Plan coverage" : "Clinic accepts insurer"}</Badge>
                        <span className="font-medium">
                          {d.kind === "coverage"
                            ? COVERAGE_LABEL[d.coverage_status ?? "unknown"]
                            : d.accepted
                              ? `Accepted${d.claim_mode ? `, ${d.claim_mode} claims` : ""}`
                              : "Not accepted"}
                        </span>
                        {d.insurance_category ? <span className="text-muted-foreground">· {d.insurance_category.replace(/_/g, " ")}</span> : null}
                        <Badge variant={d.confidence < 0.75 ? "destructive" : "secondary"}>{Math.round(d.confidence * 100)}% confident</Badge>
                      </div>
                      <blockquote className="border-l-2 pl-3 italic">&ldquo;{d.evidence_quote}&rdquo;</blockquote>
                      {d.source_url ? (
                        <p className="text-muted-foreground">
                          Source ({d.source_type.replace(/_/g, " ")}):{" "}
                          <a className="break-all underline" href={d.source_url} target="_blank" rel="noreferrer noopener">
                            {d.source_url}
                          </a>
                        </p>
                      ) : null}
                      <div className="flex gap-2">
                        <Button size="sm" disabled={busy === d.id} onClick={() => void act(d.id, true)}>
                          Approve
                        </Button>
                        <Button size="sm" variant="outline" disabled={busy === d.id} onClick={() => void act(d.id, false)}>
                          Reject
                        </Button>
                      </div>
                    </li>
                  ))}
                </ul>
              )
            }
          </QueryView>
        )}
      </CardContent>
    </Card>
  );
}

export default function OperationsPage() {
  const api = useApi();
  const [hours, setHours] = useState(24);
  const tz = userTimeZone();
  const query = useLiveQuery(
    ["operations", hours],
    async () => {
      const [activity, engines, registry, keyPoints, facts, openItems, gpQueries] = await Promise.all([
        api.getAgentActivity(hours),
        api.getEngineActivity(hours),
        api.listModelRegistry(),
        api.listKeyPoints({ statuses: ["draft"] }),
        api.listClinicalFacts({ statuses: ["draft"] }),
        api.listOpenItems({ statuses: ["open"] }),
        api.listGpQueries({ statuses: ["open"] }),
      ]);
      const waiting = [...keyPoints, ...facts, ...openItems, ...gpQueries].map((x) => Date.parse(x.created_at));
      const waitHours = waiting.length ? Math.round((Date.now() - Math.min(...waiting)) / 3_600_000) : null;
      return { activity, engines, registry, keyPoints, facts, openItems, gpQueries, waitHours };
    },
    { intervalMs: 30_000 },
  );

  return (
    <>
      <PageHeader
        title="AI operations"
        description="The agent fleet at a glance: activity, errors, engines and what's waiting for a human. No patient information is shown here."
        actions={
          <Field label="Period" className="w-40">
            <NativeSelect value={hours} onChange={(e) => setHours(Number(e.target.value))}>
              <option value={24}>Last 24 hours</option>
              <option value={168}>Last 7 days</option>
              <option value={720}>Last 30 days</option>
            </NativeSelect>
          </Field>
        }
      />
      <div className="grid gap-6">
        <QueryView query={query}>
          {({ activity, engines, registry, keyPoints, facts, openItems, gpQueries, waitHours }) => {
            const calls = activity.reduce((s, r) => s + Number(r.calls), 0);
            const errors = activity.reduce((s, r) => s + Number(r.errors), 0);
            const agentsActive = new Set(activity.map((r) => r.agent_id)).size;
            const waiting = keyPoints.length + facts.length + openItems.length + gpQueries.length;
            return (
              <>
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                  <Stat label="Tool calls" value={calls} hint={`${agentsActive} agent${agentsActive === 1 ? "" : "s"} active`} />
                  <Stat label="Error rate" value={calls ? `${Math.round((errors / calls) * 1000) / 10}%` : "—"} hint={`${errors} failed call${errors === 1 ? "" : "s"}`} />
                  <Stat label="Waiting for a human" value={waiting} hint={`${openItems.filter((o) => o.kind === "urgent").length} urgent · ${gpQueries.length} patient questions`} />
                  <Stat label="Oldest waiting" value={waitHours === null ? "—" : `${waitHours} h`} hint="Drafts and questions not yet reviewed" />
                </div>

                <Card role="region" aria-labelledby="fleet-title">
                  <CardHeader>
                    <CardTitle>
                      <h2 id="fleet-title" className="flex items-center gap-2 text-lg">
                        <Bot className="size-5" aria-hidden="true" />
                        Agent fleet activity
                      </h2>
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    {activity.length === 0 ? (
                      <EmptyState title="No agent activity in this period" />
                    ) : (
                      <div className="overflow-x-auto">
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead>Agent</TableHead>
                              <TableHead>Server · tool</TableHead>
                              <TableHead className="text-right">Calls</TableHead>
                              <TableHead className="text-right">Errors</TableHead>
                              <TableHead className="text-right">Avg / p95 (ms)</TableHead>
                              <TableHead>Last call</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {activity.map((r) => (
                              <TableRow key={`${r.agent_id}|${r.server}|${r.tool}`}>
                                <TableCell className="font-medium">{r.agent_id}</TableCell>
                                <TableCell className="font-mono text-xs">
                                  {r.server} · {r.tool}
                                </TableCell>
                                <TableCell className="text-right tabular-nums">{r.calls}</TableCell>
                                <TableCell className="text-right tabular-nums">
                                  {Number(r.errors) > 0 ? <span className="font-semibold text-destructive">{r.errors}</span> : 0}
                                </TableCell>
                                <TableCell className="text-right tabular-nums">
                                  {r.avg_latency_ms ?? "—"} / {r.p95_latency_ms ?? "—"}
                                </TableCell>
                                <TableCell className="whitespace-nowrap">{r.last_call_at ? formatDateTime(r.last_call_at, tz) : "—"}</TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </div>
                    )}
                  </CardContent>
                </Card>

                <div className="grid gap-6 lg:grid-cols-2">
                  <Card role="region" aria-labelledby="engines-title">
                    <CardHeader>
                      <CardTitle>
                        <h2 id="engines-title" className="flex items-center gap-2 text-lg">
                          <Activity className="size-5" aria-hidden="true" />
                          Engines in use
                        </h2>
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="grid gap-4">
                      {registry.length === 0 ? (
                        <p className="text-sm text-muted-foreground">No engines registered.</p>
                      ) : (
                        <ul className="grid gap-2">
                          {registry.map((e) => {
                            const used = engines.find((x) => x.engine === e.engine);
                            return (
                              <li key={e.engine} className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-2 text-sm">
                                <span>
                                  <span className="font-medium">{e.engine}</span>{" "}
                                  <span className="text-muted-foreground">
                                    ({e.capability}, {e.provider} {e.model})
                                  </span>
                                </span>
                                <span className="flex flex-wrap items-center gap-2">
                                  <Badge variant={e.enabled ? "default" : "outline"}>{e.enabled ? "Enabled" : "Off"}</Badge>
                                  {e.allow_health_data ? (
                                    <Badge variant="destructive">
                                      <ShieldOff aria-hidden="true" />
                                      May receive health data
                                    </Badge>
                                  ) : (
                                    <Badge variant="secondary">
                                      <ShieldCheck aria-hidden="true" />
                                      No health data
                                    </Badge>
                                  )}
                                  {used ? <span className="text-muted-foreground tabular-nums">{used.calls} calls · {used.avg_latency_ms ?? "—"} ms</span> : null}
                                </span>
                              </li>
                            );
                          })}
                        </ul>
                      )}
                    </CardContent>
                  </Card>

                  <Card role="region" aria-labelledby="backlog-title">
                    <CardHeader>
                      <CardTitle>
                        <h2 id="backlog-title" className="text-lg">
                          Human review backlog
                        </h2>
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      <dl className="grid grid-cols-[1fr_auto] gap-y-2 text-sm">
                        <dt>Draft key points</dt>
                        <dd className="tabular-nums">{keyPoints.length}</dd>
                        <dt>Draft facts</dt>
                        <dd className="tabular-nums">{facts.length}</dd>
                        <dt>Open items (missing info, conflicts, urgent)</dt>
                        <dd className="tabular-nums">{openItems.length}</dd>
                        <dt>Patient questions to clinicians</dt>
                        <dd className="tabular-nums">{gpQueries.length}</dd>
                      </dl>
                      <p className="mt-3 text-sm text-muted-foreground">Clinicians review these in their review queue. Agents can&apos;t approve anything themselves.</p>
                    </CardContent>
                  </Card>
                </div>
              </>
            );
          }}
        </QueryView>
        <ResearchDrafts />
      </div>
    </>
  );
}
