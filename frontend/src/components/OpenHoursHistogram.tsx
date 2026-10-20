import React, { useState } from "react";
import {
  DaySchedule,
  parseDailyOperatingHours,
  parseWeeklyOperatingSchedule,
  WeeklyOperatingSchedule,
} from "../services/dashboardData";

export interface OpenHoursHistogramProps {
  hoursText: string;
}

export { parseDailyOperatingHours, parseWeeklyOperatingSchedule };

function formatHourLabel(h: number): string {
  const norm = ((h % 24) + 24) % 24;
  if (norm === 0) return "12 AM";
  if (norm === 12) return "12 PM";
  return norm < 12 ? `${norm} AM` : `${norm - 12} PM`;
}

export const OpenHoursHistogram: React.FC<OpenHoursHistogramProps> = ({ hoursText }) => {
  const [hoveredDay, setHoveredDay] = useState<DaySchedule | null>(null);
  const parsed: WeeklyOperatingSchedule = parseWeeklyOperatingSchedule(hoursText);
  const schedule: WeeklyOperatingSchedule = parsed.unlisted
    ? parseWeeklyOperatingSchedule("Daily: 8:00 AM - 8:00 PM")
    : parsed;

  const yMin = 8;
  const yMax = 20;
  const span = Math.max(1, yMax - yMin);

  // Major time ticks from 8 AM to 8 PM
  const candidateHours = [8, 12, 16, 20];
  const yTicks = candidateHours
    .filter(h => h >= yMin && h <= yMax)
    .map(h => ({
      hour: h,
      label: formatHourLabel(h),
      pct: Math.min(100, Math.max(0, ((h - yMin) / span) * 100)),
    }));

  return (
    <div className="weekly-hist-wrap" aria-label="Operating schedule histogram">
      <div className="weekly-hist-header">
        <span className="weekly-hist-title">Schedule (Sun – Sat)</span>
        <span className="weekly-hist-hover-info">
          {hoveredDay ? (
            <strong className="weekly-hist-hover-active">
              {hoveredDay.fullName}: {hoveredDay.label}
            </strong>
          ) : schedule.isAll24Hours ? (
            <span className="weekly-hist-badge open24">Open 24 Hours</span>
          ) : schedule.isAllClosed ? (
            <span className="weekly-hist-badge closed">Closed</span>
          ) : (
            <span className="weekly-hist-hover-hint">Hover day for details</span>
          )}
        </span>
      </div>

      <div className="weekly-hist-body">
        {/* Y Axis on left */}
        <div className="weekly-hist-yaxis" aria-hidden="true">
          {yTicks.map(tick => (
            <span
              key={tick.hour}
              className="weekly-hist-ytick"
              style={{ top: `${tick.pct}%` }}
            >
              {tick.label}
            </span>
          ))}
        </div>

        {/* 7 Columns Grid */}
        <div className="weekly-hist-chart-area">
          {/* Horizontal guidelines aligned with Y-axis ticks */}
          <div className="weekly-hist-guidelines" aria-hidden="true">
            {yTicks.map(tick => (
              <div
                key={tick.hour}
                className="weekly-hist-guideline"
                style={{ top: `${tick.pct}%` }}
              />
            ))}
          </div>

          {/* Day columns */}
          <div className="weekly-hist-columns" onMouseLeave={() => setHoveredDay(null)}>
            {schedule.days.map(d => {
              const hasHours = d.isOpen && !d.isClosed;
              let topPct = 0;
              let heightPct = 100;

              if (!d.is24Hours && d.startHour !== null && d.endHour !== null) {
                const clampedStart = Math.max(yMin, Math.min(yMax, d.startHour));
                const clampedEnd = Math.max(yMin, Math.min(yMax, d.endHour));
                topPct = ((clampedStart - yMin) / span) * 100;
                heightPct = Math.max(8, ((clampedEnd - clampedStart) / span) * 100);
              }

              return (
                <div
                  key={d.day}
                  className={`weekly-hist-col ${hasHours ? "open" : "closed"} ${hoveredDay?.day === d.day ? "hovered" : ""}`}
                  onMouseEnter={() => setHoveredDay(d)}
                  title={`${d.fullName}: ${d.label}`}
                >
                  <div className="weekly-hist-col-track">
                    {hasHours ? (
                      <div
                        className="weekly-hist-col-bar"
                        style={{
                          top: d.is24Hours ? "0%" : `${topPct}%`,
                          height: d.is24Hours ? "100%" : `${heightPct}%`,
                        }}
                      />
                    ) : (
                      <div className="weekly-hist-closed-mark" aria-hidden="true">
                        —
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* X Axis row below grid */}
      <div className="weekly-hist-xaxis">
        <div className="weekly-hist-xaxis-spacer" />
        <div className="weekly-hist-xaxis-labels">
          {schedule.days.map(d => (
            <button
              type="button"
              key={d.day}
              className={`weekly-hist-xtick ${d.isOpen ? "active" : "muted"} ${hoveredDay?.day === d.day ? "selected" : ""}`}
              onMouseEnter={() => setHoveredDay(d)}
              onFocus={() => setHoveredDay(d)}
              title={`${d.fullName}: ${d.label}`}
            >
              {d.day}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};
