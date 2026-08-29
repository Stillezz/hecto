import { CrtScene } from "@/features/crt/crt-scene";
import { GrainOverlay } from "@/features/grain/grain-overlay";

import styles from "./page.module.css";

export default function Home() {
  return (
    <>
      <div className={styles.scrollTrack} aria-hidden="true" />
      <div id="crt-close" className={styles.closeMarker} aria-hidden="true" />
      <div id="crt-entry-mid" className={styles.entryMarker} aria-hidden="true" />
      <div id="camera-end" className={styles.scrollEnd} aria-hidden="true" />
      <main className={styles.page}>
        <section className={styles.stage} data-figma-node-id="31:5">
          <h1 className={styles.srOnly}>Booting Hecto OS</h1>
          <CrtScene />
        </section>
      </main>
      <GrainOverlay />
    </>
  );
}
