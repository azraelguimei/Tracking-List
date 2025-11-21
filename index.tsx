
import React, { useState, useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { GoogleGenAI } from "@google/genai";

// --- Data Types ---
interface Task {
  id: string;
  no: string;
  priority: 'H' | 'M' | 'L' | '';
  check: boolean;
  taskName: string;
  owner: string;
  
  // Input Fields for Calculation
  duration: number; // Work Day (Need days to finish)
  offsetFromEnd: number; // Total Day (How many days before project deadline)
  
  // Manual Override for Subtasks
  manualEndDate?: string; 

  // Calculated Fields
  startDate: string;
  endDate: string;
  trackingDate: string; // This acts as the End Date
  
  remainingTime: string;
  status: 'Not Started' | 'In Progress' | 'Done' | 'NA' | '';
  notes: string;
  
  parentId?: string; // If strictly a subtask
  isSubTask: boolean;
  
  // UI State Flags
  isOverdue?: boolean;
  isCompleted?: boolean;
}

interface Project {
  id: string;
  name: string;
  deadline: string;
  tasks: Task[];
  createdAt: number;
}

// --- Holiday Configuration (2025 CN) ---
// Format: YYYY-MM-DD
const HOLIDAYS_CN_2025 = new Set([
  '2025-01-01', // New Year
  // CNY (Jan 28 - Feb 4)
  '2025-01-28', '2025-01-29', '2025-01-30', '2025-01-31', 
  '2025-02-01', '2025-02-02', '2025-02-03', '2025-02-04',
  // Tomb Sweeping (Apr 4-6)
  '2025-04-04', '2025-04-05', '2025-04-06',
  // Labor Day (May 1-5)
  '2025-05-01', '2025-05-02', '2025-05-03', '2025-05-04', '2025-05-05',
  // Dragon Boat (May 31 - Jun 2)
  '2025-05-31', '2025-06-01', '2025-06-02',
  // National Day + Mid Autumn (Oct 1 - Oct 8)
  '2025-10-01', '2025-10-02', '2025-10-03', '2025-10-04', 
  '2025-10-05', '2025-10-06', '2025-10-07', '2025-10-08'
]);

// --- Date Helpers ---
const formatDate = (date: Date): string => {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
};

const addDays = (dateStr: string, days: number): string => {
  if (!dateStr) return '';
  const result = new Date(dateStr);
  result.setDate(result.getDate() + days);
  return formatDate(result);
};

const getDaysDiff = (targetDateStr: string): number => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = new Date(targetDateStr);
  const diffTime = target.getTime() - today.getTime();
  return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
};

// Check if a date is a working day (ONLY exclude Holidays, Weekends are Workdays)
const isWorkDay = (date: Date): boolean => {
  const dateStr = formatDate(date);
  
  // Check Holiday
  if (HOLIDAYS_CN_2025.has(dateStr)) return false;
  
  // Weekends are now considered working days
  return true;
};

// Calculate Start Date by counting backwards 'workDays' from 'endDate'
const calculateStartDateInWorkDays = (endDateStr: string, workDays: number): string => {
  if (workDays <= 0) return endDateStr;
  
  let current = new Date(endDateStr);
  let daysNeeded = workDays;
  
  // We iterate backwards. 
  // If duration is 1 day, and today is WorkDay, Start = End.
  // Logic: find the span of time that contains `workDays` amount of working days, ending at `endDate`.
  
  while (daysNeeded > 0) {
    if (isWorkDay(current)) {
      daysNeeded--;
    }
    
    // If we still need days, move back one day
    if (daysNeeded > 0) {
      current.setDate(current.getDate() - 1);
    }
  }
  
  return formatDate(current);
};

// Hydrate tasks with calculations (Pure Function)
const calculateTasks = (deadline: string, currentTasks: any[]) => {
  // First, get parent mapping for quick access
  const parentMap = new Map(currentTasks.filter(t => !t.isSubTask).map(t => [t.id, t]));

  return currentTasks.map(t => {
    let trackingDate = '';
    let startDate = '';
    
    if (t.isSubTask) {
      // Subtask Date Logic:
      // 1. Use Manual Date if set
      // 2. Default to Parent's Calculated Date
      // 3. Default to global deadline if orphan
      
      const parent = parentMap.get(t.parentId);
      const parentTrackingDate = parent 
        ? addDays(deadline, -parent.offsetFromEnd) 
        : deadline;

      trackingDate = t.manualEndDate || parentTrackingDate;
      startDate = ''; // Subtasks usually don't have start date calculated here unless requested

    } else {
      // Main Tasks Calculation
      // 1. Calculate End Date (Tracking Date) based on Calendar Days Offset
      trackingDate = addDays(deadline, -t.offsetFromEnd);
      
      // 2. Calculate Start Date based on Work Days
      startDate = calculateStartDateInWorkDays(trackingDate, t.duration);
    }

    // --- Step 1: Determine Status (Logic moved up) ---
    let calculatedStatus = t.status; 
    
    if (!t.isSubTask) {
      // Find children of this task
      const children = currentTasks.filter(child => child.parentId === t.id);
      
      if (children.length > 0) {
        const total = children.length;
        const checkedCount = children.filter(c => c.check).length;
        
        if (checkedCount === total) {
          calculatedStatus = 'Done';
        } else if (checkedCount > 0) {
          calculatedStatus = 'In Progress';
        } else {
          calculatedStatus = 'Not Started';
        }
      }
    } else {
      calculatedStatus = 'NA';
    }

    // --- Step 2: Determine Remaining Time based on Status ---
    const daysLeft = getDaysDiff(trackingDate);
    let remainingTimeStr = '';
    let isOverdue = false;
    let isCompleted = false;

    // Completion Condition:
    // 1. Main Task is 'Done'
    // 2. Subtask is Checked
    if ((!t.isSubTask && calculatedStatus === 'Done') || (t.isSubTask && t.check)) {
      remainingTimeStr = '已完成';
      isCompleted = true;
    } else {
      if (daysLeft < 0) {
        remainingTimeStr = `已過期 ${Math.abs(daysLeft)} 天`;
        isOverdue = true;
      } else {
        remainingTimeStr = `剩餘 ${daysLeft} 天`;
      }
    }

    return {
      ...t,
      startDate,
      endDate: trackingDate, 
      trackingDate,
      remainingTime: remainingTimeStr,
      isOverdue,
      isCompleted,
      status: calculatedStatus,
      check: t.check || false,
      notes: t.notes || '',
      manualEndDate: t.manualEndDate || undefined // Ensure it exists
    } as Task;
  });
};

// --- Initial Data Setup ---
const defaultDeadline = '2025-11-30';
const defaultTasksConfig: Partial<Task>[] = [
  { id: '1', no: '1', priority: 'H', taskName: 'SMT', owner: '', duration: 1, offsetFromEnd: 0, status: 'Not Started' },
  { id: '2', no: '2', priority: 'L', taskName: '入料緩衝期', owner: 'ME', duration: 7, offsetFromEnd: 1, status: 'Not Started' },
  { id: '3', no: '3', priority: 'M', taskName: 'Cable製作', owner: 'Vendor', duration: 35, offsetFromEnd: 8, status: 'In Progress' },
  { id: '4', no: '4', priority: 'L', taskName: '繪圖+對圖', owner: 'ME', duration: 21, offsetFromEnd: 43, status: 'Not Started' }, 
  { id: '4-1', parentId: '4', no: '4-1', check: true, taskName: 'Pin Define Check', owner: 'HW', isSubTask: true },
  { id: '4-2', parentId: '4', no: '4-2', check: true, taskName: 'EMC Request Check', owner: 'EMC', isSubTask: true },
  { id: '4-3', parentId: '4', no: '4-3', check: false, taskName: '公母頭連接型號確認', owner: 'ME', isSubTask: true },
  { id: '4-4', parentId: '4', no: '4-4', check: false, taskName: 'DM/DL Approval', owner: 'DM/DL', isSubTask: true },
];

const initialProject: Project = {
  id: 'default-project-1',
  name: 'NPI Project Alpha',
  deadline: defaultDeadline,
  tasks: calculateTasks(defaultDeadline, defaultTasksConfig),
  createdAt: Date.now()
};

const LOCAL_STORAGE_KEY = 'task_tracker_data_v1';

const App = () => {
  // --- State ---
  const [projects, setProjects] = useState<Project[]>([initialProject]);
  const [currentProjectId, setCurrentProjectId] = useState<string>(initialProject.id);
  const [showProjectMenu, setShowProjectMenu] = useState(false);
  const projectMenuRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // --- Persistence Effect ---
  useEffect(() => {
    const savedData = localStorage.getItem(LOCAL_STORAGE_KEY);
    if (savedData) {
      try {
        const parsed = JSON.parse(savedData);
        if (parsed.projects && Array.isArray(parsed.projects) && parsed.projects.length > 0) {
          setProjects(parsed.projects);
          if (parsed.currentProjectId) {
            setCurrentProjectId(parsed.currentProjectId);
          }
        }
      } catch (e) {
        console.error("Failed to load saved data", e);
      }
    }
  }, []);

  // Get Current Project Derived Data
  const currentProject = projects.find(p => p.id === currentProjectId) || projects[0];
  const { tasks, name: projectName, deadline: projectDeadline } = currentProject;

  // --- Updaters (Replace simple setState with Project-aware updaters) ---

  // Update the entire tasks array for current project (and force recalculation)
  const updateCurrentProjectTasks = (taskUpdater: (prevTasks: Task[]) => Task[]) => {
    setProjects(prev => prev.map(p => {
      if (p.id === currentProjectId) {
        const newRawTasks = taskUpdater(p.tasks);
        // Critical: Recalculate based on current deadline
        const recalculated = calculateTasks(p.deadline, newRawTasks);
        return { ...p, tasks: recalculated };
      }
      return p;
    }));
  };

  // Update Project Name
  const updateProjectName = (newName: string) => {
    setProjects(prev => prev.map(p => p.id === currentProjectId ? { ...p, name: newName } : p));
  };

  // Update Project Deadline (recalculates all tasks)
  const updateProjectDeadline = (newDeadline: string) => {
    setProjects(prev => prev.map(p => {
      if (p.id === currentProjectId) {
        const recalculated = calculateTasks(newDeadline, p.tasks);
        return { ...p, deadline: newDeadline, tasks: recalculated };
      }
      return p;
    }));
  };

  // --- Data Management Actions ---
  const handleSave = () => {
    const dataToSave = {
      projects,
      currentProjectId
    };
    try {
      localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(dataToSave));
      // Simple visual feedback
      const btn = document.getElementById('save-btn');
      if (btn) {
        const originalText = btn.innerHTML;
        btn.innerHTML = '<svg class="w-5 h-5 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" /></svg><span class="hidden md:inline text-green-600">已儲存</span>';
        setTimeout(() => {
          btn.innerHTML = originalText;
        }, 1500);
      }
    } catch (e) {
      alert('儲存失敗，可能是瀏覽器儲存空間不足');
    }
  };

  const handleExport = () => {
    const dataStr = JSON.stringify({ projects, currentProjectId }, null, 2);
    const blob = new Blob([dataStr], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `task_tracker_backup_${new Date().toISOString().split('T')[0]}.json`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setShowProjectMenu(false);
  };

  const handleImportClick = () => {
    fileInputRef.current?.click();
  };

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const content = e.target?.result as string;
        const parsed = JSON.parse(content);
        if (parsed.projects && Array.isArray(parsed.projects)) {
          // Recalculate tasks for all imported projects to ensure consistency
          const rehydratedProjects = parsed.projects.map((p: Project) => ({
             ...p,
             tasks: calculateTasks(p.deadline, p.tasks)
          }));

          setProjects(rehydratedProjects);
          if (parsed.currentProjectId) {
            setCurrentProjectId(parsed.currentProjectId);
          } else {
            setCurrentProjectId(rehydratedProjects[0].id);
          }
          alert('匯入成功！已還原專案資料。');
          setShowProjectMenu(false);
        } else {
          alert('檔案格式錯誤：找不到專案資料');
        }
      } catch (err) {
        alert('無法讀取檔案，請確認格式是否正確');
        console.error(err);
      }
    };
    reader.readAsText(file);
    // Reset input
    event.target.value = '';
  };

  // --- Project Management Actions ---
  const handleCreateProject = () => {
    const newId = `proj-${Date.now()}`;
    const newProject: Project = {
      id: newId,
      name: 'New Project ' + (projects.length + 1),
      deadline: defaultDeadline,
      tasks: calculateTasks(defaultDeadline, defaultTasksConfig),
      createdAt: Date.now()
    };
    setProjects(prev => [...prev, newProject]);
    setCurrentProjectId(newId);
    setShowProjectMenu(false);
  };

  const handleSwitchProject = (id: string) => {
    setCurrentProjectId(id);
    setShowProjectMenu(false);
  };

  const handleDeleteProject = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    if (projects.length <= 1) {
      alert("至少需要保留一個專案");
      return;
    }
    if (!confirm("確定要刪除此專案嗎？此動作無法復原。")) return;

    const newProjects = projects.filter(p => p.id !== id);
    setProjects(newProjects);
    if (currentProjectId === id) {
      setCurrentProjectId(newProjects[0].id);
    }
  };

  // Close menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (projectMenuRef.current && !projectMenuRef.current.contains(event.target as Node)) {
        setShowProjectMenu(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const [aiPrompt, setAiPrompt] = useState('');
  const [aiResponse, setAiResponse] = useState('');
  const [loading, setLoading] = useState(false);
  const [showAi, setShowAi] = useState(false);

  // --- Add Task Modal State ---
  const [showAddModal, setShowAddModal] = useState(false);
  const [newTaskType, setNewTaskType] = useState<'main' | 'sub'>('main');
  const [newTaskData, setNewTaskData] = useState({
    taskName: '',
    owner: '',
    priority: 'M',
    duration: 5,
    offsetFromEnd: 10,
    parentId: '',
  });

  // --- Handlers ---
  
  const updateTaskField = (id: string, field: keyof Task, value: any) => {
    updateCurrentProjectTasks(prev => {
      return prev.map(t => t.id === id ? { ...t, [field]: value } : t);
    });
  };

  const handleCheck = (id: string) => {
    updateCurrentProjectTasks(prev => {
      return prev.map(t => t.id === id ? { ...t, check: !t.check } : t);
    });
  };

  const handleDelete = (id: string) => {
    if (!confirm('確定要刪除此任務嗎？\n注意：若刪除主任務，其下的子任務也會一併被刪除。')) return;
    
    updateCurrentProjectTasks(prev => {
      const taskToDelete = prev.find(t => t.id === id);
      if (!taskToDelete) return prev;

      // Filter out the task itself
      let newTasks = prev.filter(t => t.id !== id);

      // If it's a main task, also filter out its children
      if (!taskToDelete.isSubTask) {
        newTasks = newTasks.filter(t => t.parentId !== id);
      }

      return newTasks;
    });
  };

  const handlePrint = () => {
    try {
      window.print();
    } catch (error) {
      console.error("Print failed:", error);
      alert("無法啟動列印功能，請嘗試使用 Ctrl+P (Windows) 或 Cmd+P (Mac)");
    }
  };

  // --- Add Task Logic ---
  const openAddModal = () => {
    setShowAddModal(true);
    setNewTaskData({
      taskName: '',
      owner: '',
      priority: 'M',
      duration: 5,
      offsetFromEnd: 10,
      parentId: '',
    });
    setNewTaskType('main');
  };

  const handleAddTask = () => {
    if (!newTaskData.taskName) {
      alert('請輸入任務名稱');
      return;
    }

    let newTask: any;
    const newId = `new-${Date.now()}`;

    if (newTaskType === 'main') {
      const mainTasks = tasks.filter(t => !t.isSubTask);
      const lastNo = mainTasks.length > 0 ? parseInt(mainTasks[mainTasks.length - 1].no) : 0;
      const nextNo = (lastNo + 1).toString();

      newTask = {
        id: newId,
        no: nextNo,
        priority: newTaskData.priority as any,
        taskName: newTaskData.taskName,
        owner: newTaskData.owner,
        duration: newTaskData.duration,
        offsetFromEnd: newTaskData.offsetFromEnd,
        status: 'Not Started',
        isSubTask: false,
        notes: ''
      };
    } else {
      if (!newTaskData.parentId) {
        alert('請選擇一個主任務');
        return;
      }
      const parent = tasks.find(t => t.id === newTaskData.parentId);
      if (!parent) return;

      const siblings = tasks.filter(t => t.parentId === newTaskData.parentId);
      const nextSubNo = siblings.length + 1;
      const nextNoStr = `${parent.no}-${nextSubNo}`;

      newTask = {
        id: newId,
        no: nextNoStr,
        parentId: newTaskData.parentId,
        taskName: newTaskData.taskName,
        owner: newTaskData.owner,
        check: false,
        isSubTask: true,
        notes: ''
      };
    }

    updateCurrentProjectTasks(prev => {
      const newList = [...prev];
      
      if (newTaskType === 'sub') {
        let insertIndex = -1;
        for (let i = newList.length - 1; i >= 0; i--) {
          if (newList[i].id === newTaskData.parentId || newList[i].parentId === newTaskData.parentId) {
            insertIndex = i;
            break;
          }
        }
        if (insertIndex !== -1) {
          newList.splice(insertIndex + 1, 0, newTask);
        } else {
          newList.push(newTask);
        }
      } else {
        newList.push(newTask);
      }
      return newList;
    });

    setShowAddModal(false);
  };


  // --- Gemini API Integration ---
  const askGemini = async () => {
    if (!aiPrompt.trim()) return;
    setLoading(true);
    
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY || '' });
      
      const dataContext = JSON.stringify({
        project: projectName,
        deadline: projectDeadline,
        note: "Start Dates exclude ONLY 2025 CN Holidays (Weekends are working days)",
        tasks: tasks.map(t => ({
          no: t.no,
          task: t.taskName,
          type: t.isSubTask ? 'SubTask' : 'MainNode',
          status: t.status,
          check: t.check,
          workDaysNeeded: t.duration,
          daysBeforeDeadline: t.offsetFromEnd,
          endDate: t.trackingDate,
          isManualDate: !!t.manualEndDate,
          startDate: t.startDate,
          isOverdue: (t as any).isOverdue
        }))
      });

      const systemInstruction = `
        你是一位專業的專案管理大師 (PM Master)。
        使用者正在使用一個「以終為始」(Backwards Scheduling) 的排程工具。
        
        目前的專案數據 (JSON):
        ${dataContext}
        
        邏輯說明：
        1. 專案有一個最終 Deadline。
        2. 每個主要任務設定「距離 Deadline 幾天前須完成」(Offset，日曆天)。
        3. 子任務 (SubTask) 通常繼承父任務的截止日，但使用者可以手動指定子任務的截止日 (manualEndDate)。
        4. Start Date 是根據 Work Day (Duration) 倒推計算的，系統僅扣除 2025 年中國國定假日，週末照常計算。
        5. 父任務的狀態 (Status) 是根據子任務的勾選狀況自動決定的 (全勾=Done, 部分=In Progress)。

        請回答使用者的問題。如果是詢問時程安排是否合理，請檢查工時與緩衝時間。
        請用繁體中文回答，語氣專業且有幫助。
      `;

      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: aiPrompt,
        config: {
          systemInstruction: systemInstruction,
          temperature: 0.7,
        }
      });

      setAiResponse(response.text || '無法產生回應');
    } catch (error) {
      console.error(error);
      setAiResponse('發生錯誤，請檢查 API Key。');
    } finally {
      setLoading(false);
    }
  };

  // --- Styles ---
  const getPriorityStyle = (p: string) => {
    switch (p) {
      case 'H': return 'bg-pink-100 text-red-700 border-pink-200';
      case 'M': return 'bg-amber-100 text-amber-800 border-amber-200';
      case 'L': return 'bg-green-100 text-green-800 border-green-200';
      default: return 'bg-transparent text-gray-400';
    }
  };

  const getRemainingStyle = (t: string, isOverdue: boolean, isCompleted: boolean) => {
    if (isCompleted) return 'bg-gray-200 text-gray-500 font-medium px-2 py-0.5 rounded';
    if (t === 'NA') return 'text-gray-300';
    if (isOverdue) return 'bg-red-100 text-red-600 font-bold px-2 py-0.5 rounded';
    return 'bg-emerald-100 text-emerald-700 px-2 py-0.5 rounded';
  };

  return (
    <div className="min-h-screen flex flex-col font-sans bg-gray-50 text-slate-800 relative print:block print:h-auto print:bg-white">
      
      {/* Hidden File Input for Import */}
      <input 
        type="file" 
        ref={fileInputRef} 
        onChange={handleFileChange} 
        className="hidden" 
        accept=".json"
      />

      {/* Print-Specific Styles & Animations */}
      <style>{`
        @media print {
          @page { margin: 10mm; size: landscape; }
          body { -webkit-print-color-adjust: exact; print-color-adjust: exact; background: white; }
          input, select, textarea { 
            border: none !important; 
            background: transparent !important; 
            box-shadow: none !important;
            padding: 0 !important;
            appearance: none !important;
          }
          select { text-indent: 0.01px; text-overflow: ''; }
          .custom-scrollbar::-webkit-scrollbar { display: none; }
        }
        @keyframes slideInRight {
          from { transform: translateX(100%); opacity: 0; }
          to { transform: translateX(0); opacity: 1; }
        }
        .animate-slide-in-right {
          animation: slideInRight 0.3s ease-out forwards;
        }
        @keyframes fadeInUp {
          from { transform: translateY(20px); opacity: 0; }
          to { transform: translateY(0); opacity: 1; }
        }
        .animate-fade-in-up {
          animation: fadeInUp 0.3s ease-out forwards;
        }
        @keyframes fadeIn {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        .animate-fade-in {
          animation: fadeIn 0.2s ease-out forwards;
        }
      `}</style>

      {/* 1. Global Project Settings Bar (Hidden on Print) */}
      <div className="bg-white border-b border-gray-200 px-6 py-4 shadow-sm sticky top-0 z-50 print:hidden">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          
          {/* Project Switcher Section */}
          <div className="flex items-center gap-4 flex-1 relative" ref={projectMenuRef}>
            <button 
              onClick={() => setShowProjectMenu(!showProjectMenu)}
              className="bg-indigo-600 hover:bg-indigo-700 transition-colors text-white p-2 rounded-lg shadow-md flex items-center gap-1 group"
              title="切換專案"
            >
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" /></svg>
              <svg className={`w-3 h-3 transition-transform duration-200 ${showProjectMenu ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M19 9l-7 7-7-7" /></svg>
            </button>

            {/* Project Switcher Dropdown */}
            {showProjectMenu && (
              <div className="absolute top-12 left-0 w-72 bg-white rounded-xl shadow-2xl border border-gray-100 overflow-hidden z-50 animate-fade-in flex flex-col">
                <div className="p-3 bg-gray-50 border-b border-gray-100 text-xs font-bold text-gray-500 uppercase tracking-wider">
                  切換專案 (Switch Project)
                </div>
                <div className="max-h-64 overflow-y-auto custom-scrollbar p-1">
                  {projects.map(p => (
                    <div 
                      key={p.id}
                      onClick={() => handleSwitchProject(p.id)}
                      className={`flex items-center justify-between px-3 py-2 rounded-lg cursor-pointer transition-colors mb-1 group ${p.id === currentProjectId ? 'bg-indigo-50 text-indigo-700' : 'hover:bg-gray-100 text-gray-700'}`}
                    >
                      <div className="flex flex-col">
                        <span className="font-medium text-sm truncate max-w-[160px]">{p.name}</span>
                        <span className="text-[10px] opacity-60">{p.deadline}</span>
                      </div>
                      {p.id === currentProjectId && (
                        <svg className="w-4 h-4 text-indigo-600" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                      )}
                      {projects.length > 1 && (
                        <button 
                          onClick={(e) => handleDeleteProject(e, p.id)}
                          className="opacity-0 group-hover:opacity-100 p-1 hover:bg-red-100 rounded text-gray-400 hover:text-red-500 transition-all ml-2"
                          title="刪除專案"
                        >
                          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                        </button>
                      )}
                    </div>
                  ))}
                </div>
                <div className="p-2 border-t border-gray-100 bg-gray-50 space-y-2">
                  <button 
                    onClick={handleCreateProject}
                    className="w-full flex items-center justify-center gap-2 py-2 bg-white border border-gray-300 hover:border-indigo-300 hover:text-indigo-600 rounded-lg text-sm font-medium transition-all shadow-sm text-gray-600"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" /></svg>
                    建立新專案
                  </button>
                  <div className="flex gap-2">
                    <button 
                      onClick={handleExport}
                      className="flex-1 flex items-center justify-center gap-1 py-1.5 bg-white border border-gray-200 hover:bg-gray-50 rounded text-xs text-gray-600"
                      title="匯出 JSON"
                    >
                       <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>
                       匯出
                    </button>
                    <button 
                      onClick={handleImportClick}
                      className="flex-1 flex items-center justify-center gap-1 py-1.5 bg-white border border-gray-200 hover:bg-gray-50 rounded text-xs text-gray-600"
                      title="匯入 JSON"
                    >
                       <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" /></svg>
                       匯入
                    </button>
                  </div>
                </div>
              </div>
            )}

            <div>
              <label className="block text-xs font-bold text-gray-400 uppercase tracking-wider">專案名稱 Project Name</label>
              <input 
                type="text" 
                value={projectName}
                onChange={(e) => updateProjectName(e.target.value)}
                className="text-xl font-bold text-gray-800 bg-transparent outline-none border-b border-transparent hover:border-gray-300 focus:border-indigo-500 transition-all w-full md:w-64"
              />
            </div>
          </div>

          <div className="flex items-center gap-6 bg-indigo-50 px-4 py-2 rounded-lg border border-indigo-100">
            <div className="text-right">
              <label className="block text-xs font-bold text-indigo-400 uppercase tracking-wider">設定最終 Deadline</label>
              <div className="text-xs text-indigo-400">所有任務將以此日期回推</div>
            </div>
            <input 
              type="date" 
              value={projectDeadline}
              onChange={(e) => updateProjectDeadline(e.target.value)}
              className="bg-white border border-indigo-200 text-indigo-700 text-lg font-bold rounded px-3 py-1 outline-none focus:ring-2 focus:ring-indigo-500 shadow-sm cursor-pointer"
            />
          </div>

          <div className="flex items-center gap-3">
             {/* PDF Export Button */}
             <button 
              onClick={handlePrint}
              className="flex items-center gap-2 px-3 py-2 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-100 hover:text-indigo-600 transition-all shadow-sm"
              title="列印 / 另存 PDF"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z" />
              </svg>
              <span className="hidden md:inline text-xs font-bold">報表</span>
            </button>

            {/* Save Button */}
            <button 
              id="save-btn"
              onClick={handleSave}
              className="flex items-center gap-2 px-3 py-2 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-100 hover:text-emerald-600 transition-all shadow-sm"
              title="儲存專案"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-3m-1 4l-3 3m0 0l-3-3m3 3V4" />
              </svg>
              <span className="hidden md:inline text-xs font-bold">儲存</span>
            </button>

            <button 
              onClick={openAddModal}
              className="flex items-center gap-2 px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white font-medium shadow-sm transition-all"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" /></svg>
              新增任務
            </button>
            
            <button 
              onClick={() => setShowAi(!showAi)}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg transition font-medium shadow-sm ${showAi ? 'bg-gray-800 text-white' : 'bg-white border border-gray-300 text-gray-700 hover:bg-gray-50'}`}
            >
              {showAi ? '關閉助理' : 'AI 專案助理'}
            </button>
          </div>
        </div>
      </div>

      {/* Report Header (Visible Only in Print) */}
      <div className="hidden print:block px-6 py-4 border-b border-gray-300 mb-4">
        <div className="flex justify-between items-end">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">{projectName}</h1>
            <p className="text-sm text-gray-600 mt-1">Project Task Tracking Report</p>
          </div>
          <div className="text-right">
            <div className="text-sm text-gray-500">Project Deadline: <span className="font-bold text-gray-900">{projectDeadline}</span></div>
            <div className="text-xs text-gray-400 mt-1">Generated on: {new Date().toLocaleDateString()}</div>
          </div>
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden print:overflow-visible print:block">
        
        {/* Main Table Area */}
        <div className="flex-1 overflow-auto p-6 custom-scrollbar print:p-0 print:overflow-visible print:block">
          <div className="bg-white shadow-xl rounded-lg border border-gray-200 overflow-hidden min-w-[1200px] print:min-w-0 print:shadow-none print:border-none">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="bg-slate-100 text-slate-600 font-bold h-12 border-b border-gray-300 print:bg-gray-50 print:h-auto">
                  <th className="px-2 w-12 text-center print:border print:border-gray-300">No.</th>
                  <th className="px-2 w-20 text-center print:border print:border-gray-300">Priority</th>
                  <th className="px-2 w-12 text-center print:border print:border-gray-300">Check</th>
                  <th className="px-4 text-left w-64 print:border print:border-gray-300">Task Node / Subtasks</th>
                  <th className="px-2 w-20 text-center print:border print:border-gray-300">Owner</th>
                  
                  {/* Calculated Section */}
                  <th className="px-2 w-28 text-center bg-slate-50 text-slate-500 print:bg-transparent print:text-gray-700 print:border print:border-gray-300">
                     <div className="flex flex-col">
                      <span>Start Date</span>
                      <span className="text-[9px] font-normal opacity-75 text-red-400 print:hidden">*Excl. Holidays</span>
                    </div>
                  </th>
                  <th className="px-2 w-28 text-center bg-slate-50 text-slate-500 border-r border-slate-200 print:bg-transparent print:text-gray-700 print:border print:border-gray-300">
                    <div className="flex flex-col">
                      <span>End / Due Date</span>
                      <span className="text-[9px] font-normal opacity-75 print:hidden">Main: Auto / Sub: Manual</span>
                    </div>
                  </th>
                  
                  <th className="px-2 w-36 text-center print:border print:border-gray-300">Remaining Time</th>
                  <th className="px-2 w-28 text-left print:border print:border-gray-300">Status</th>
                  <th className="px-2 w-40 text-left print:border print:border-gray-300">Notes</th>

                  {/* User Input Section (Hidden on Print) */}
                  <th className="px-2 w-24 text-center bg-amber-50 text-amber-700 border-l border-amber-100 print:hidden">
                    <div className="flex flex-col">
                      <span>Work Day</span>
                      <span className="text-[10px] font-normal opacity-75">(Duration)</span>
                    </div>
                  </th>
                  <th className="px-2 w-24 text-center bg-amber-50 text-amber-700 border-r border-amber-100 print:hidden">
                    <div className="flex flex-col">
                      <span>Offset Day</span>
                      <span className="text-[10px] font-normal opacity-75">(From Deadline)</span>
                    </div>
                  </th>

                  <th className="px-2 w-10 text-center print:hidden"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 print:divide-gray-300">
                {tasks.map((task, idx) => {
                  const isSub = task.isSubTask;
                  const hasChildren = tasks.some(t => t.parentId === task.id);
                  
                  return (
                    <tr 
                      key={task.id} 
                      className={`
                        hover:bg-blue-50 transition-colors
                        ${isSub ? 'bg-gray-50/50' : 'bg-white'}
                        print:break-inside-avoid print:hover:bg-transparent
                      `}
                    >
                      {/* No */}
                      <td className="text-center py-3 text-gray-500 font-mono print:border print:border-gray-300 print:py-1">{task.no}</td>
                      
                      {/* Priority */}
                      <td className="text-center p-2 print:border print:border-gray-300 print:p-1">
                        {!isSub && (
                          <div className="relative inline-block w-full">
                            <select
                              value={task.priority}
                              onChange={(e) => updateTaskField(task.id, 'priority', e.target.value)}
                              className={`w-full text-xs px-1 py-1 rounded border font-bold text-center outline-none appearance-none cursor-pointer transition-colors ${getPriorityStyle(task.priority)}`}
                              style={{textAlignLast: 'center'}}
                            >
                              <option value="H" className="bg-white text-gray-800">H</option>
                              <option value="M" className="bg-white text-gray-800">M</option>
                              <option value="L" className="bg-white text-gray-800">L</option>
                              <option value="" className="bg-white text-gray-400">-</option>
                            </select>
                          </div>
                        )}
                      </td>
                      
                      {/* Check */}
                      <td className="text-center print:border print:border-gray-300 print:p-1">
                        {isSub ? (
                          <input 
                            type="checkbox" 
                            checked={task.check} 
                            onChange={() => handleCheck(task.id)}
                            className="w-5 h-5 accent-indigo-600 cursor-pointer border-gray-300 rounded focus:ring-indigo-500 print:w-4 print:h-4"
                          />
                        ) : null}
                      </td>
                      
                      {/* Task Name */}
                      <td className="px-4 py-2 print:border print:border-gray-300 print:px-2 print:py-1">
                        <div className={`flex items-center ${isSub ? 'pl-6 border-l-2 border-gray-200 print:border-none print:pl-4' : ''}`}>
                          {isSub && <div className="w-2 h-2 bg-gray-300 rounded-full mr-2 print:bg-gray-400"></div>}
                          <input 
                            type="text" 
                            value={task.taskName}
                            onChange={(e) => updateTaskField(task.id, 'taskName', e.target.value)}
                            className={`w-full bg-transparent outline-none border-b border-transparent focus:border-indigo-400 px-1 py-0.5 ${isSub ? 'text-gray-600' : 'font-semibold text-gray-800'}`}
                          />
                        </div>
                      </td>
                      
                      {/* Owner */}
                      <td className="text-center print:border print:border-gray-300 print:p-1">
                        <input 
                          type="text"
                          value={task.owner}
                          onChange={(e) => updateTaskField(task.id, 'owner', e.target.value)}
                          className="w-full text-center bg-transparent outline-none border-b border-transparent focus:border-indigo-400 text-xs text-gray-600"
                        />
                      </td>
                      
                      {/* CALCULATED: Dates */}
                      <td className="text-center py-2 text-gray-500 bg-slate-50/50 font-mono text-xs print:bg-transparent print:text-gray-900 print:border print:border-gray-300 print:py-1">
                        {task.startDate || '-'}
                      </td>
                      <td className="text-center py-2 text-gray-800 bg-slate-50/50 font-mono text-xs border-r border-slate-200 relative group print:bg-transparent print:border print:border-gray-300 print:py-1">
                         {isSub ? (
                           <div className="flex items-center justify-center gap-1">
                             <input 
                               type="date"
                               value={task.trackingDate}
                               onChange={(e) => updateTaskField(task.id, 'manualEndDate', e.target.value)}
                               className={`text-center text-xs w-28 h-7 px-1 rounded cursor-pointer outline-none transition-colors border
                                 ${task.manualEndDate 
                                   ? 'bg-indigo-50 border-indigo-300 text-indigo-700 font-bold shadow-sm print:text-black print:bg-transparent print:border-none print:font-normal' 
                                   : 'bg-white border-gray-300 text-gray-700 hover:border-gray-400 hover:bg-gray-50 print:border-none'}
                               `}
                             />
                           </div>
                         ) : (
                           <span className="font-bold">{task.trackingDate}</span>
                         )}
                      </td>
                      
                      {/* Remaining Time */}
                      <td className="text-center py-2 print:border print:border-gray-300 print:py-1">
                        <span className={`text-xs font-medium ${getRemainingStyle(task.remainingTime, (task as any).isOverdue, (task as any).isCompleted)} print:bg-transparent print:text-black print:font-normal`}>
                          {task.remainingTime}
                        </span>
                      </td>
                      
                      {/* Status */}
                      <td className="px-2 print:border print:border-gray-300 print:p-1">
                         {!isSub && (
                            hasChildren ? (
                                <div className={`text-xs font-bold px-2 py-1 rounded text-center shadow-sm border
                                  ${task.status === 'Done' ? 'bg-green-100 text-green-700 border-green-200' : 
                                    task.status === 'In Progress' ? 'bg-yellow-100 text-yellow-700 border-yellow-200' : 
                                    'bg-gray-100 text-gray-500 border-gray-200'}
                                  print:bg-transparent print:border-none print:text-black print:shadow-none print:font-normal
                                  `}>
                                  {task.status}
                                </div>
                            ) : (
                              <select 
                                value={task.status}
                                onChange={(e) => updateTaskField(task.id, 'status', e.target.value)}
                                className="text-xs bg-transparent border-none outline-none cursor-pointer hover:bg-gray-100 rounded p-1 w-full"
                              >
                                <option value="Not Started">Not Started</option>
                                <option value="In Progress">In Progress</option>
                                <option value="Done">Done</option>
                              </select>
                            )
                         )}
                      </td>
                      
                      {/* Notes */}
                      <td className="px-2 print:border print:border-gray-300 print:p-1">
                        <input 
                          type="text"
                          value={task.notes}
                          onChange={(e) => updateTaskField(task.id, 'notes', e.target.value)}
                          className="w-full bg-transparent text-xs text-gray-500 outline-none border-b border-transparent focus:border-blue-300"
                          placeholder={isSub ? "..." : "Add notes"}
                        />
                      </td>

                      {/* INPUTS: Work Day & Offset (Hidden on Print) */}
                      <td className="text-center bg-amber-50/50 border-l border-amber-100/50 print:hidden">
                        {!isSub && (
                          <input 
                            type="number"
                            value={task.duration}
                            onChange={(e) => updateTaskField(task.id, 'duration', parseInt(e.target.value) || 0)}
                            className="w-16 text-center bg-white border border-amber-200 rounded text-amber-900 font-mono focus:ring-2 focus:ring-amber-400 outline-none"
                          />
                        )}
                      </td>
                      <td className="text-center bg-amber-50/50 border-r border-amber-100/50 relative print:hidden">
                        {!isSub && (
                          <>
                            <input 
                              type="number"
                              value={task.offsetFromEnd}
                              onChange={(e) => updateTaskField(task.id, 'offsetFromEnd', parseInt(e.target.value) || 0)}
                              className="w-16 text-center bg-white border border-amber-200 rounded text-amber-900 font-mono focus:ring-2 focus:ring-amber-400 outline-none"
                            />
                            <span className="absolute right-1 top-4 text-[10px] text-amber-400">-days</span>
                          </>
                        )}
                      </td>

                      {/* Delete Action (Hidden on Print) */}
                      <td className="text-center px-2 print:hidden">
                        <button 
                          onClick={() => handleDelete(task.id)}
                          className="text-gray-300 hover:text-red-500 transition-colors p-1 rounded-full hover:bg-red-50"
                          title="Delete Task"
                        >
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                          </svg>
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          
          <div className="mt-6 text-gray-500 text-xs flex gap-4 print:hidden">
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 bg-amber-50 border border-amber-200"></div>
              <span>黃色區域為輸入欄位 (Input)</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 bg-slate-50 border border-gray-200"></div>
              <span>灰色區域為自動計算 (Auto-calculated)</span>
            </div>
             <div className="flex items-center gap-2">
              <div className="w-3 h-3 bg-indigo-50 border border-indigo-100 flex items-center justify-center text-[8px] text-indigo-500 font-bold">M</div>
              <span>子任務可手動設定日期 (Manual Date)</span>
            </div>
            <div className="flex items-center gap-2 ml-auto text-red-400">
              <span>* Start Date 自動扣除 2025 中國國定假日 (週末照常計算)</span>
            </div>
          </div>
        </div>

        {/* AI Assistant Sidebar (Hidden on Print) */}
        {showAi && (
          <div className="w-96 bg-white shadow-2xl border-l border-gray-200 flex flex-col animate-slide-in-right z-20 print:hidden">
            <div className="p-4 bg-gradient-to-r from-indigo-600 to-blue-500 text-white">
              <h2 className="text-lg font-bold flex items-center gap-2">
                <span>🤖</span> Project Copilot
              </h2>
              <p className="text-xs text-indigo-100 mt-1 opacity-90">協助您檢視排程邏輯與風險</p>
            </div>
            
            <div className="flex-1 p-4 overflow-y-auto bg-gray-50">
              {aiResponse ? (
                 <div className="bg-white p-4 rounded-xl shadow-sm border border-gray-200 prose prose-sm max-w-none">
                   <div className="font-medium mb-2 text-indigo-600 text-xs uppercase flex items-center gap-2">
                      <div className="w-2 h-2 bg-indigo-500 rounded-full"></div>
                      Gemini Analysis
                   </div>
                   <div className="whitespace-pre-wrap leading-relaxed text-gray-800 text-sm">{aiResponse}</div>
                 </div>
              ) : (
                <div className="text-center text-gray-400 mt-10 space-y-6">
                  <div className="text-5xl opacity-20">📅</div>
                  <div>
                    <p className="font-medium text-gray-500">試試看這樣問：</p>
                    <ul className="text-sm text-left list-none pl-0 mt-4 space-y-3 px-4">
                      <li className="bg-white p-3 rounded border border-gray-200 cursor-pointer hover:border-indigo-400 hover:shadow-sm transition"
                          onClick={() => setAiPrompt("如果 Deadline 提前一週，哪些任務會變得很趕？")}>
                        "如果 Deadline 提前一週，哪些任務會變得很趕？"
                      </li>
                      <li className="bg-white p-3 rounded border border-gray-200 cursor-pointer hover:border-indigo-400 hover:shadow-sm transition"
                          onClick={() => setAiPrompt("請檢查 No.3 的工時設定是否合理？")}>
                        "請檢查 No.3 的工時設定是否合理？"
                      </li>
                      <li className="bg-white p-3 rounded border border-gray-200 cursor-pointer hover:border-indigo-400 hover:shadow-sm transition"
                          onClick={() => setAiPrompt("幫我產生一份這個專案的進度報告摘要")}>
                        "幫我產生一份這個專案的進度報告摘要"
                      </li>
                    </ul>
                  </div>
                </div>
              )}
            </div>

            <div className="p-4 bg-white border-t border-gray-200">
              <div className="relative">
                <textarea
                  className="w-full border border-gray-300 rounded-xl p-3 pr-10 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none resize-none text-sm bg-gray-50 focus:bg-white transition-colors"
                  rows={3}
                  placeholder="輸入訊息..."
                  value={aiPrompt}
                  onChange={(e) => setAiPrompt(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      askGemini();
                    }
                  }}
                />
                <button 
                  onClick={askGemini}
                  disabled={loading || !aiPrompt}
                  className={`absolute bottom-3 right-3 p-2 rounded-lg transition-colors ${
                    loading || !aiPrompt ? 'text-gray-300 bg-transparent' : 'text-white bg-indigo-600 hover:bg-indigo-700 shadow-sm'
                  }`}
                >
                  {loading ? (
                    <svg className="animate-spin h-5 w-5" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                    </svg>
                  ) : (
                    <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
                    </svg>
                  )}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Add Task Modal (Hidden on Print) */}
        {showAddModal && (
          <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 p-4 print:hidden">
            <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden animate-fade-in-up">
              <div className="bg-slate-50 border-b border-gray-200 p-4 flex justify-between items-center">
                <h3 className="font-bold text-gray-800 text-lg">新增任務</h3>
                <button onClick={() => setShowAddModal(false)} className="text-gray-400 hover:text-gray-600">
                   <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                </button>
              </div>
              
              <div className="p-6 space-y-4">
                {/* Type Selector */}
                <div className="grid grid-cols-2 gap-2 bg-gray-100 p-1 rounded-lg">
                  <button 
                    onClick={() => setNewTaskType('main')}
                    className={`py-2 rounded-md text-sm font-medium transition-all ${newTaskType === 'main' ? 'bg-white text-indigo-600 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}
                  >
                    建立主任務 (Node)
                  </button>
                  <button 
                    onClick={() => setNewTaskType('sub')}
                    className={`py-2 rounded-md text-sm font-medium transition-all ${newTaskType === 'sub' ? 'bg-white text-indigo-600 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}
                  >
                    建立子任務 (Subtask)
                  </button>
                </div>

                {/* Common Fields */}
                <div className="space-y-4">
                   {newTaskType === 'sub' && (
                     <div>
                       <label className="block text-xs font-bold text-gray-500 mb-1">選擇隸屬的主任務</label>
                       <select 
                         value={newTaskData.parentId}
                         onChange={(e) => setNewTaskData({...newTaskData, parentId: e.target.value})}
                         className="w-full bg-white text-gray-900 border border-gray-300 rounded-lg px-3 py-2 outline-none focus:ring-2 focus:ring-indigo-500"
                       >
                         <option value="">-- 請選擇 --</option>
                         {tasks.filter(t => !t.isSubTask).map(t => (
                           <option key={t.id} value={t.id}>{t.no}. {t.taskName}</option>
                         ))}
                       </select>
                     </div>
                   )}

                   <div>
                     <label className="block text-xs font-bold text-gray-500 mb-1">任務名稱</label>
                     <input 
                       type="text"
                       value={newTaskData.taskName}
                       onChange={(e) => setNewTaskData({...newTaskData, taskName: e.target.value})}
                       className="w-full bg-white text-gray-900 border border-gray-300 rounded-lg px-3 py-2 outline-none focus:ring-2 focus:ring-indigo-500"
                       placeholder="輸入任務名稱..."
                     />
                   </div>

                   <div>
                     <label className="block text-xs font-bold text-gray-500 mb-1">負責人 (Owner)</label>
                     <input 
                       type="text"
                       value={newTaskData.owner}
                       onChange={(e) => setNewTaskData({...newTaskData, owner: e.target.value})}
                       className="w-full bg-white text-gray-900 border border-gray-300 rounded-lg px-3 py-2 outline-none focus:ring-2 focus:ring-indigo-500"
                       placeholder="例如: ME, Vendor"
                     />
                   </div>

                   {newTaskType === 'main' && (
                     <>
                       <div>
                         <label className="block text-xs font-bold text-gray-500 mb-1">優先級 (Priority)</label>
                         <select 
                           value={newTaskData.priority}
                           onChange={(e) => setNewTaskData({...newTaskData, priority: e.target.value as any})}
                           className="w-full bg-white text-gray-900 border border-gray-300 rounded-lg px-3 py-2 outline-none focus:ring-2 focus:ring-indigo-500"
                         >
                           <option value="H">High (H)</option>
                           <option value="M">Medium (M)</option>
                           <option value="L">Low (L)</option>
                         </select>
                       </div>
                       
                       <div className="grid grid-cols-2 gap-4">
                         <div>
                           <label className="block text-xs font-bold text-amber-600 mb-1">工時 (Work Days)</label>
                           <input 
                             type="number"
                             min="1"
                             value={newTaskData.duration}
                             onChange={(e) => setNewTaskData({...newTaskData, duration: parseInt(e.target.value) || 0})}
                             className="w-full border border-amber-300 bg-amber-50 text-amber-900 rounded-lg px-3 py-2 outline-none focus:ring-2 focus:ring-amber-500"
                           />
                         </div>
                         <div>
                           <label className="block text-xs font-bold text-amber-600 mb-1">Deadline 前置天數</label>
                           <input 
                             type="number"
                             min="0"
                             value={newTaskData.offsetFromEnd}
                             onChange={(e) => setNewTaskData({...newTaskData, offsetFromEnd: parseInt(e.target.value) || 0})}
                             className="w-full border border-amber-300 bg-amber-50 text-amber-900 rounded-lg px-3 py-2 outline-none focus:ring-2 focus:ring-amber-500"
                           />
                         </div>
                       </div>
                     </>
                   )}
                </div>
              </div>

              <div className="bg-gray-50 p-4 border-t border-gray-200 flex justify-end gap-3">
                <button 
                  onClick={() => setShowAddModal(false)}
                  className="px-4 py-2 text-gray-600 font-medium hover:bg-gray-100 rounded-lg transition"
                >
                  取消
                </button>
                <button 
                  onClick={handleAddTask}
                  className="px-4 py-2 bg-indigo-600 text-white font-bold rounded-lg hover:bg-indigo-700 shadow-md transition"
                >
                  建立任務
                </button>
              </div>
            </div>
          </div>
        )}

      </div>
    </div>
  );
};

const root = createRoot(document.getElementById('root')!);
root.render(<App />);
