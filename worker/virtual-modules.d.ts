declare module "virtual:sen-assistant-knowledge" {
  export interface AssistantTutorial {
    id: string;
    title: string;
    summary: string;
    screen: string;
    chapters: { title: string; t: number }[];
  }
  export const KNOWLEDGE: string;
  export const TUTORIALS: AssistantTutorial[];
}
