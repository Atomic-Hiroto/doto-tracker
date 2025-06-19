import fs from 'fs';
import { ChannelData } from '../models/ChannelData';
import { ProcessConstants } from '../constants';
import { logger } from './loggerService';

export class ChannelDataService {
  private channelData: ChannelData[] = [];
  private channelDataMap: Map<string, ChannelData> = new Map();
  private readonly channelDataFile = ProcessConstants.DATA_FOLDER + '/channelData.json';

  constructor() {
    this.loadChannelData();
  }

  private loadChannelData() {
    try {
      if (fs.existsSync(this.channelDataFile)) {
        this.channelData = JSON.parse(fs.readFileSync(this.channelDataFile, 'utf8'));
        this.channelData.forEach(channel => {
          this.channelDataMap.set(channel.channelId, channel);
        });
        logger.info('Channel data loaded successfully');
      }
    } catch (error) {
      logger.error('Error loading channel data:', error);
      this.channelData = [];
    }
  }

  private saveChannelData() {
    try {
      fs.writeFileSync(this.channelDataFile, JSON.stringify(this.channelData, null, 2));
    } catch (error) {
      logger.error('Error saving channel data:', error);
    }
  }

  getChannelById(channelId: string): ChannelData | undefined {
    return this.channelDataMap.get(channelId);
  }

  setSharedContext(channelId: string, sharedContext: boolean) {
    let channelData = this.channelDataMap.get(channelId);
    
    if (channelData) {
      channelData.sharedContext = sharedContext;
    } else {
      channelData = { channelId, sharedContext };
      this.channelData.push(channelData);
      this.channelDataMap.set(channelId, channelData);
    }
    
    this.saveChannelData();
  }

  isSharedContext(channelId: string): boolean {
    const channelData = this.channelDataMap.get(channelId);
    return channelData ? channelData.sharedContext : false;
  }
}