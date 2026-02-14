/**
 * Host Election Algorithm
 * 
 * Deterministically elects the best peer to act as host based on:
 * - Connection quality (latency, packet loss, jitter)
 * - NAT type (open > moderate > strict)
 * - Bandwidth capacity
 * - Peer ID (tiebreaker for determinism)
 */

export interface PeerConnectionStats {
  peerId: string;
  latency: number; // RTT in ms
  packetLoss: number; // 0-1 (percentage)
  jitter: number; // ms
  bandwidth: number; // estimated upload bandwidth in kbps
}

export interface PeerCapability {
  peerId: string;
  natType: 'open' | 'moderate' | 'strict' | 'unknown';
  platform: 'desktop' | 'web' | 'mobile' | 'unknown';
  bandwidth: number; // kbps
}

export interface HostScore {
  peerId: string;
  totalScore: number;
  scores: {
    connectionQuality: number;
    natType: number;
    bandwidth: number;
    platform: number;
    tiebreaker: number;
  };
}

/**
 * Host Election Manager
 */
export class HostElection {
  // Scoring weights
  private static readonly WEIGHTS = {
    connectionQuality: 0.35,
    natType: 0.25,
    bandwidth: 0.25,
    platform: 0.10,
    tiebreaker: 0.05
  };
  
  /**
   * Elect a host from a list of peers
   * All peers run this same algorithm on same data → same result (deterministic)
   */
  static electHost(
    peers: string[],
    stats: Map<string, PeerConnectionStats>,
    capabilities: Map<string, PeerCapability>
  ): string {
    if (peers.length === 0) {
      throw new Error('Cannot elect host: no peers available');
    }
    
    if (peers.length === 1) {
      return peers[0];
    }
    
    // Score all peers
    const scores: HostScore[] = peers.map(peerId => {
      return this.scorePeer(peerId, stats.get(peerId), capabilities.get(peerId));
    });
    
    // Sort by total score (descending)
    scores.sort((a, b) => b.totalScore - a.totalScore);
    
    const winner = scores[0];
    console.log('[HostElection] Election results:', {
      winner: winner.peerId,
      score: winner.totalScore.toFixed(2),
      allScores: scores.map(s => ({
        peerId: s.peerId,
        score: s.totalScore.toFixed(2)
      }))
    });
    
    return winner.peerId;
  }
  
  /**
   * Score a single peer
   */
  private static scorePeer(
    peerId: string,
    stats?: PeerConnectionStats,
    capability?: PeerCapability
  ): HostScore {
    const scores = {
      connectionQuality: this.scoreConnectionQuality(stats),
      natType: this.scoreNATType(capability?.natType),
      bandwidth: this.scoreBandwidth(capability?.bandwidth || stats?.bandwidth),
      platform: this.scorePlatform(capability?.platform),
      tiebreaker: this.scoreTiebreaker(peerId)
    };
    
    // Calculate weighted total
    const totalScore =
      scores.connectionQuality * this.WEIGHTS.connectionQuality +
      scores.natType * this.WEIGHTS.natType +
      scores.bandwidth * this.WEIGHTS.bandwidth +
      scores.platform * this.WEIGHTS.platform +
      scores.tiebreaker * this.WEIGHTS.tiebreaker;
    
    return {
      peerId,
      totalScore,
      scores
    };
  }
  
  /**
   * Score connection quality (0-100)
   * Based on latency, packet loss, and jitter
   */
  private static scoreConnectionQuality(stats?: PeerConnectionStats): number {
    if (!stats) return 50; // Default score if no stats
    
    // Latency score (lower is better, 0-50ms = 100, >200ms = 0)
    const latencyScore = Math.max(0, 100 - (stats.latency / 200) * 100);
    
    // Packet loss score (0% = 100, >5% = 0)
    const packetLossScore = Math.max(0, 100 - (stats.packetLoss * 100) * 20);
    
    // Jitter score (lower is better, 0-20ms = 100, >100ms = 0)
    const jitterScore = Math.max(0, 100 - (stats.jitter / 100) * 100);
    
    // Weighted average
    return latencyScore * 0.4 + packetLossScore * 0.4 + jitterScore * 0.2;
  }
  
  /**
   * Score NAT type (0-100)
   */
  private static scoreNATType(natType?: string): number {
    switch (natType) {
      case 'open':
        return 100; // Best - can accept incoming connections
      case 'moderate':
        return 60; // Ok - some restrictions
      case 'strict':
        return 20; // Poor - hard to reach
      default:
        return 50; // Unknown - assume moderate
    }
  }
  
  /**
   * Score bandwidth (0-100)
   * Based on upload bandwidth capacity
   */
  private static scoreBandwidth(bandwidth?: number): number {
    if (!bandwidth) return 50; // Default if unknown
    
    // For voice chat host, need good upload bandwidth
    // 500 kbps = decent (100), 2000+ kbps = excellent (100)
    // <100 kbps = poor (0)
    
    if (bandwidth >= 2000) return 100;
    if (bandwidth < 100) return 0;
    
    // Linear scale between 100-2000 kbps
    return ((bandwidth - 100) / 1900) * 100;
  }
  
  /**
   * Score platform (0-100)
   * Desktop is preferred over web/mobile for stability
   */
  private static scorePlatform(platform?: string): number {
    switch (platform) {
      case 'desktop':
        return 100; // Best - stable, powerful
      case 'web':
        return 60; // Ok - browser limitations
      case 'mobile':
        return 40; // Poorer - battery/network concerns
      default:
        return 50; // Unknown
    }
  }
  
  /**
   * Tiebreaker score based on peer ID hash
   * Ensures deterministic result when peers have identical scores
   */
  private static scoreTiebreaker(peerId: string): number {
    // Simple hash of peer ID
    let hash = 0;
    for (let i = 0; i < peerId.length; i++) {
      hash = ((hash << 5) - hash) + peerId.charCodeAt(i);
      hash = hash & hash; // Convert to 32-bit integer
    }
    
    // Normalize to 0-100
    return Math.abs(hash % 100);
  }
  
  /**
   * Check if current host should be replaced
   * Uses hysteresis to avoid frequent switching
   */
  static shouldReplaceHost(
    currentHostId: string,
    peers: string[],
    stats: Map<string, PeerConnectionStats>,
    capabilities: Map<string, PeerCapability>,
    hysteresisThreshold: number = 15 // Points difference needed to switch
  ): { shouldReplace: boolean; newHostId?: string } {
    if (!peers.includes(currentHostId)) {
      // Current host disconnected, must elect new one
      const newHostId = this.electHost(peers, stats, capabilities);
      return { shouldReplace: true, newHostId };
    }
    
    // Score current host
    const currentHostScore = this.scorePeer(
      currentHostId,
      stats.get(currentHostId),
      capabilities.get(currentHostId)
    );
    
    // Find best alternative
    const alternativePeers = peers.filter(p => p !== currentHostId);
    if (alternativePeers.length === 0) {
      return { shouldReplace: false };
    }
    
    const bestAlternative = this.electHost(alternativePeers, stats, capabilities);
    const bestAlternativeScore = this.scorePeer(
      bestAlternative,
      stats.get(bestAlternative),
      capabilities.get(bestAlternative)
    );
    
    // Only replace if alternative is significantly better (hysteresis)
    const scoreDiff = bestAlternativeScore.totalScore - currentHostScore.totalScore;
    
    if (scoreDiff > hysteresisThreshold) {
      console.log(`[HostElection] Recommending host change: ${currentHostId} → ${bestAlternative} (score diff: +${scoreDiff.toFixed(2)})`);
      return { shouldReplace: true, newHostId: bestAlternative };
    }
    
    return { shouldReplace: false };
  }
  
  /**
   * Get peer scores for display/debugging
   */
  static getPeerScores(
    peers: string[],
    stats: Map<string, PeerConnectionStats>,
    capabilities: Map<string, PeerCapability>
  ): HostScore[] {
    return peers.map(peerId => {
      return this.scorePeer(peerId, stats.get(peerId), capabilities.get(peerId));
    }).sort((a, b) => b.totalScore - a.totalScore);
  }
}
