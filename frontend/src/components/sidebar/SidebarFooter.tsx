import { AuthMenu } from '../layout/AuthMenu';
import { SettingsMenu } from '../layout/SettingsMenu';
import styles from './SidebarFooter.module.css';

export interface SidebarFooterProps {
  collapsed: boolean;
  onExpand: () => void;
}

/** Bottom-left identity + settings (sidebar restyle). Collapsed → icon rail (avatar + gear).
 *  The account avatar expands the sidebar; the gear opens the settings dialog (which carries the
 *  language and usage-metrics preferences — formerly a cramped inline popover + a separate toggle).
 *  SettingsMenu stays mounted in both states, so its telemetry-pref server→local reconcile
 *  (useTelemetryPref) runs whenever the sidebar is on screen — NOT only while the dialog is open;
 *  LocaleProvider handles the language reconcile regardless. */
export function SidebarFooter({ collapsed, onExpand }: SidebarFooterProps) {
  return (
    <div className={`${styles.footer} ${collapsed ? styles.collapsed : ''}`}>
      <AuthMenu collapsed={collapsed} onExpand={onExpand} />
      <SettingsMenu collapsed={collapsed} />
    </div>
  );
}
