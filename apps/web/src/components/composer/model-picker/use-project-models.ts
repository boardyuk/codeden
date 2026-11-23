import type { ProjectModelsResponse, ProviderInfo } from "@codeden/contracts";
import { useQueries } from "@tanstack/react-query";
import { useMemo } from "react";
import { useClient } from "@/lib/api";

/** Query key of one provider's model list for one project. */
export const projectModelsKey = (projectId: string, providerId: string) =>
  ["project-models", projectId, providerId] as const;

const dataOf = (results: { data?: ProjectModelsResponse }[]) => results.map((r) => r.data);

export interface ProjectProviders {
  providers: ProviderInfo[];
  /** Per provider id: what of the project's own config was left out, and why. */
  warnings: ReadonlyMap<string, readonly string[]>;
}

/**
 * The providers with each one's models for this project (#643): a provider whose list depends on
 * the project (`capabilities.projectModels`, e.g. OpenCode with a project `opencode.json`) gets
 * the list made with the project's own config. The others, every provider without a project,
 * and a provider whose project list is still loading keep their usual list.
 */
export function useProjectProviders(
  projectId: string | null | undefined,
  providers: ProviderInfo[],
): ProjectProviders {
  const client = useClient();
  const ids = projectId
    ? providers.filter((p) => p.capabilities.projectModels).map((p) => p.id)
    : [];
  const lists = useQueries({
    queries: ids.map((id) => ({
      queryKey: projectModelsKey(projectId ?? "", id),
      queryFn: () => client.projectModels(id, projectId ?? ""),
      staleTime: 5 * 60_000,
      retry: false,
    })),
    combine: dataOf,
  });
  return useMemo(() => {
    const byId = new Map<string, ProjectModelsResponse>();
    for (const list of lists)
      if (list && list.projectId === projectId) byId.set(list.providerId, list);
    const warnings = new Map<string, readonly string[]>();
    for (const [id, list] of byId) if (list.warnings.length) warnings.set(id, list.warnings);
    if (byId.size === 0) return { providers, warnings };
    return {
      providers: providers.map((p) => {
        const list = byId.get(p.id);
        return list && list.models.length > 0 ? { ...p, models: list.models } : p;
      }),
      warnings,
    };
  }, [providers, lists, projectId]);
}
