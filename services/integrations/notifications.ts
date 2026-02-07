import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';
import { config } from '../shared/config';
import { createLogger } from '../shared/logger';
import { Notification, UserProfile } from '../shared/schemas';
import { notificationRepository, userRepository } from './dynamodb';
import { ulid } from 'ulid';

const logger = createLogger('NotificationService');

const client = new SNSClient({
  region: config.aws.region,
  ...(config.aws.awsEndpoint && { endpoint: config.aws.awsEndpoint }),
});

export type NotificationType =
  | 'match_proposed'
  | 'match_accepted'
  | 'scheduled'
  | 'en_route'
  | 'picked_up'
  | 'delivered'
  | 'canceled'
  | 'compliance_blocked';

export interface NotificationInput {
  userId: string;
  type: NotificationType;
  title: string;
  message: string;
  entityType: string;
  entityId: string;
}

class NotificationService {
  /**
   * Send notification to a user based on their preferences
   */
  async send(input: NotificationInput): Promise<void> {
    const now = new Date().toISOString();

    try {
      // Get user profile to check preferences
      const user = await userRepository.get(input.userId);

      if (!user) {
        logger.warn('User not found for notification', { userId: input.userId });
        return;
      }

      const userProfile = user as UserProfile;
      const preferences = userProfile.notificationPreferences || {
        email: true,
        sms: false,
        inApp: true,
        notificationTypes: ['match_proposed', 'match_accepted', 'scheduled', 'picked_up', 'delivered', 'canceled'],
      };

      // Check if user wants this type of notification
      if (!preferences.notificationTypes.includes(input.type as any)) {
        logger.debug('User has disabled this notification type', {
          userId: input.userId,
          type: input.type,
        });
        return;
      }

      const deliveryChannels: Array<'email' | 'sms' | 'in_app'> = [];
      if (preferences.email) deliveryChannels.push('email');
      if (preferences.sms) deliveryChannels.push('sms');
      if (preferences.inApp) deliveryChannels.push('in_app');

      // Create notification record
      const notification: Notification = {
        id: ulid(),
        userId: input.userId,
        type: input.type,
        title: input.title,
        message: input.message,
        entityType: input.entityType,
        entityId: input.entityId,
        read: false,
        deliveryChannels,
        deliveryStatus: {},
        createdAt: now,
      };

      // Store in DynamoDB for in-app notifications
      await notificationRepository.put(notification as any);

      // Send via SNS for email/SMS
      if (preferences.email || preferences.sms) {
        await this.publishToSNS(notification, userProfile);
      }

      logger.info('Notification sent', {
        userId: input.userId,
        type: input.type,
        channels: deliveryChannels,
      });
    } catch (error) {
      logger.error('Failed to send notification', error as Error, { input });
      // Don't throw - notification failures shouldn't block operations
    }
  }

  /**
   * Publish notification to SNS
   */
  private async publishToSNS(notification: Notification, user: UserProfile): Promise<void> {
    try {
      const message = `${notification.title}\n\n${notification.message}`;

      const messageAttributes: Record<string, any> = {
        notificationType: {
          DataType: 'String',
          StringValue: notification.type,
        },
        userId: {
          DataType: 'String',
          StringValue: user.userId,
        },
      };

      // Add email if user wants email notifications
      if (notification.deliveryChannels.includes('email') && user.email) {
        messageAttributes.email = {
          DataType: 'String',
          StringValue: user.email,
        };
      }

      // Add phone if user wants SMS notifications
      if (notification.deliveryChannels.includes('sms') && user.phone) {
        messageAttributes.phone = {
          DataType: 'String',
          StringValue: user.phone,
        };
      }

      await client.send(
        new PublishCommand({
          TopicArn: config.sns.notificationsTopicArn,
          Message: message,
          Subject: notification.title,
          MessageAttributes: messageAttributes,
        })
      );

      logger.debug('Notification published to SNS', { notificationId: notification.id });
    } catch (error) {
      logger.error('Failed to publish to SNS', error as Error, {
        notificationId: notification.id,
      });
    }
  }

  /**
   * Send notifications to multiple users
   */
  async sendBatch(inputs: NotificationInput[]): Promise<void> {
    await Promise.all(inputs.map(input => this.send(input)));
  }

  /**
   * Get unread notifications for a user
   */
  async getUnread(userId: string, limit: number = 50): Promise<Notification[]> {
    const allNotifications = await notificationRepository.queryByUser(userId, limit * 2);

    const unread = (allNotifications as Notification[])
      .filter(n => !n.read)
      .slice(0, limit);

    return unread;
  }

  /**
   * Mark notification as read
   */
  async markAsRead(notificationId: string): Promise<void> {
    try {
      await notificationRepository.updateFields(
        notificationId,
        {
          read: true,
          readAt: new Date().toISOString(),
        } as any
      );

      logger.debug('Notification marked as read', { notificationId });
    } catch (error) {
      logger.error('Failed to mark notification as read', error as Error, { notificationId });
    }
  }
}

// Singleton instance
export const notificationService = new NotificationService();
