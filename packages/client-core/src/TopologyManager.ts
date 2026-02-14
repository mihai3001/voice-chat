/**
 * Topology Manager
 * 
 * Manages switching between mesh and host-based topologies:
 * - Mesh: ≤4 peers (everyone connects to everyone)
 * - Host: 5+ peers (everyone connects to host, host forwards audio)
 */

export type TopologyType = 'mesh' | 'host';

export interface TopologyConfig {
  meshThreshold: number; // Max peers for mesh mode (default: 4)
}

export interface TopologyChangeEvent {
  oldTopology: TopologyType;
  newTopology: TopologyType;
  peerCount: number;
  hostPeerId?: string;
}

export class TopologyManager {
  private currentTopology: TopologyType = 'mesh';
  private peerCount = 0;
  private config: TopologyConfig;
  
  // Event handlers
  private onTopologyChangeHandler?: (event: TopologyChangeEvent) => void;
  
  constructor(config?: Partial<TopologyConfig>) {
    this.config = {
      meshThreshold: 4,
      ...config
    };
  }
  
  /**
   * Update peer count and check if topology should change
   */
  updatePeerCount(count: number, currentHostPeerId?: string): TopologyType {
    const oldCount = this.peerCount;
    const oldTopology = this.currentTopology;
    this.peerCount = count;
    
    // Determine new topology based on peer count
    const newTopology = this.determineTopology(count);
    
    // If topology changed, notify
    if (newTopology !== oldTopology) {
      console.log(`[TopologyManager] Switching from ${oldTopology} to ${newTopology} topology (${count} peers)`);
      
      this.currentTopology = newTopology;
      
      if (this.onTopologyChangeHandler) {
        this.onTopologyChangeHandler({
          oldTopology,
          newTopology,
          peerCount: count,
          hostPeerId: currentHostPeerId
        });
      }
    }
    
    return newTopology;
  }
  
  /**
   * Determine topology based on peer count
   */
  private determineTopology(peerCount: number): TopologyType {
    // Total participants = peerCount + 1 (self)
    const totalParticipants = peerCount + 1;
    
    if (totalParticipants <= this.config.meshThreshold) {
      return 'mesh';
    } else {
      return 'host';
    }
  }
  
  /**
   * Get current topology
   */
  getCurrentTopology(): TopologyType {
    return this.currentTopology;
  }
  
  /**
   * Get current peer count
   */
  getPeerCount(): number {
    return this.peerCount;
  }
  
  /**
   * Check if should use mesh topology
   */
  shouldUseMesh(): boolean {
    return this.currentTopology === 'mesh';
  }
  
  /**
   * Check if should use host topology
   */
  shouldUseHost(): boolean {
    return this.currentTopology === 'host';
  }
  
  /**
   * Force a topology (for testing or manual override)
   */
  forceTopology(topology: TopologyType): void {
    if (topology !== this.currentTopology) {
      const oldTopology = this.currentTopology;
      this.currentTopology = topology;
      
      console.log(`[TopologyManager] Force switched to ${topology} topology`);
      
      if (this.onTopologyChangeHandler) {
        this.onTopologyChangeHandler({
          oldTopology,
          newTopology: topology,
          peerCount: this.peerCount
        });
      }
    }
  }
  
  /**
   * Get recommended action when topology changes
   */
  getTopologyTransitionAction(event: TopologyChangeEvent): string {
    if (event.newTopology === 'host' && event.oldTopology === 'mesh') {
      return 'ELECT_HOST'; // Need to elect a host
    } else if (event.newTopology === 'mesh' && event.oldTopology === 'host') {
      return 'DISSOLVE_HOST'; // Switch back to mesh
    }
    return 'NONE';
  }
  
  /**
   * Event handlers
   */
  onTopologyChange(handler: (event: TopologyChangeEvent) => void): void {
    this.onTopologyChangeHandler = handler;
  }
  
  /**
   * Get configuration
   */
  getConfig(): TopologyConfig {
    return { ...this.config };
  }
  
  /**
   * Update configuration
   */
  updateConfig(config: Partial<TopologyConfig>): void {
    this.config = {
      ...this.config,
      ...config
    };
    
    // Re-evaluate topology with new config
    this.updatePeerCount(this.peerCount);
  }
}
