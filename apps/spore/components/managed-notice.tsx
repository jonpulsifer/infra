import { GitPullRequest } from 'lucide-react';
import { Badge } from '@/components/ui/badge';

export function ManagedNotice({
  children = 'Boot configuration is generated from Git by Nix. Changes ship through a pull request.',
}: {
  children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 rounded-sm border border-spore/30 bg-spore/5 p-4 font-mono text-sm sm:flex-row sm:items-center">
      <Badge variant="spore" className="w-fit shrink-0">
        <GitPullRequest className="mr-1 h-3 w-3" />
        Git / Nix managed
      </Badge>
      <p className="text-muted-foreground">{children}</p>
    </div>
  );
}
