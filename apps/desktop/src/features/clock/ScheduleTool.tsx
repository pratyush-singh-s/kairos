import { Schedules } from "../timer/Schedules";

/** Timer page "Schedule" tab: focus or blocking at set times. */
export function ScheduleTool() {
  return (
    <div className="schedule-tool">
      <Schedules title="Schedule block" askKind />
    </div>
  );
}
