import fs from 'fs';
import { UserData } from '../models/UserData';
import { ProcessConstants } from '../constants';
import { logger } from './loggerService';

export class UserDataService {
  private userData: UserData[] = [];
  private userDataMap: Map<string, UserData> = new Map();

  constructor() {
    this.loadUserData();
  }

  private loadUserData() {
    try {
      this.userData = JSON.parse(fs.readFileSync(ProcessConstants.USER_DATA_FILE, 'utf8'));
      this.userData.forEach(user => {
        this.userDataMap.set(user.discordId, user);
      });
      logger.info('User data loaded successfully');
    } catch (error) {
      logger.error('Error loading user data:', error);
      this.userData = [];
    }
  }

  saveUserData() {
    fs.writeFileSync(ProcessConstants.USER_DATA_FILE, JSON.stringify(this.userData, null, 2));
  }

  getUserByDiscordId(discordId: string): UserData | undefined {
    return this.userDataMap.get(discordId);
  }

  getUserBySteamId(steamId: string): UserData | undefined {
    return this.userData.find(user => user.steamId === steamId);
  }

  addUser(user: UserData) {
    this.userData.push(user);
    this.userDataMap.set(user.discordId, user);
    this.saveUserData();
  }

  updateUser(user: UserData) {
    const index = this.userData.findIndex(u => u.discordId === user.discordId);
    if (index !== -1) {
      this.userData[index] = user;
      this.userDataMap.set(user.discordId, user);
      this.saveUserData();
    }
  }

  deleteUser(discordId: string) {
    this.userData = this.userData.filter(user => user.discordId !== discordId);
    this.userDataMap.delete(discordId);
    this.saveUserData();
  }

  getAllUsers(): UserData[] {
    return this.userData;
  }
}