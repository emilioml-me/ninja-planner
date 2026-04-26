import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { ArrowDown, ArrowUp } from 'lucide-react';

interface StatCardProps {
  label: string;
  value: string;
  change?: { value: number; isPositive: boolean };
  icon?: React.ReactNode;
}

export function StatCard({ label, value, change, icon }: StatCardProps) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <p className="text-sm text-muted-foreground">{label}</p>
        {icon && <div className="text-muted-foreground">{icon}</div>}
      </CardHeader>
      <CardContent>
        <div className="text-3xl font-semibold">{value}</div>
        {change && (
          <div className="mt-2 flex items-center gap-1 text-xs">
            {change.isPositive ? (
              <ArrowUp className="h-3 w-3 text-green-600" />
            ) : (
              <ArrowDown className="h-3 w-3 text-red-600" />
            )}
            <span className={change.isPositive ? 'text-green-600' : 'text-red-600'}>
              {Math.abs(change.value)}%
            </span>
            <span className="text-muted-foreground">vs last period</span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
