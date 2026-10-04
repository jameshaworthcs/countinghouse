// Every month in review, newest first: the year read at a glance, each month's headline, key points
// and how the month before's lines to watch turned out, with your feedback. Each opens on the
// Overview beside its month's figures.

import { useState } from 'react';
import { Link } from 'react-router';
import { formatMonth } from '../../shared/dates';
import type { Insight } from '../../shared/schema';
import { latestReview, ReviewView } from '../components/MonthReview';
import { Card, EmptyState, Loading, PageHeader, Segmented } from '../components/ui';
import { useApi } from '../lib/api';

export default function Reviews() {
  const reviews = useApi<Insight[]>(['insights', 'month-review'], '/insights?kind=month-review&all=1');
  const [view, setView] = useState<'short' | 'full'>('short');
  if (!reviews.data) return <Loading />;
  const months = [...new Set(reviews.data.map((r) => r.subject.month).filter((m): m is string => Boolean(m)))].sort().reverse();
  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Month in review"
        subtitle="Claude’s reviews of your months: inferred, not calculated. Each sits beside its month’s figures on the Overview."
        actions={
          <Segmented
            size="sm"
            label="Show"
            value={view}
            onChange={setView}
            options={[
              { value: 'short', label: 'Key points' },
              { value: 'full', label: 'In full' },
            ]}
          />
        }
      />
      {!months.length && <EmptyState title="No reviews yet">Write one from the Overview’s Month in review.</EmptyState>}
      <ol className="flex flex-col gap-4">
        {months.map((m) => {
          const review = latestReview(reviews.data ?? [], m);
          if (!review) return null;
          return (
            <li key={m}>
              <Card
                title={formatMonth(m)}
                actions={
                  <Link to={`/?month=${m}#month-review`} className="text-[12.5px] text-accent hover:underline">
                    With its figures
                  </Link>
                }
              >
                <ReviewView review={review} compact={view === 'short'} />
              </Card>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
