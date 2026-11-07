// A plain Element Plus form, with its reactive model mirrored to window.__values.
import { createApp, h, reactive, watch } from 'vue';
import {
  ElButton, ElCascader, ElCheckbox, ElCheckboxGroup, ElDatePicker, ElForm, ElFormItem,
  ElInput, ElInputNumber, ElOption, ElRadio, ElRadioGroup, ElSelect,
} from 'element-plus';

const REGIONS = [
  { value: '广东省', label: '广东省', children: [
    { value: '深圳市', label: '深圳市', children: [{ value: '南山区', label: '南山区' }, { value: '福田区', label: '福田区' }] },
  ] },
  { value: '浙江省', label: '浙江省', children: [
    { value: '杭州市', label: '杭州市', children: [{ value: '西湖区', label: '西湖区' }] },
  ] },
];

const model = reactive<any>({ name: '', email: '', gender: '', city: '', degree: '', region: [], joined: '', years: undefined, skills: [] });
watch(model, () => { (window as any).__values = JSON.parse(JSON.stringify(model)); }, { deep: true });

const item = (label: string, control: () => unknown) =>
  h(ElFormItem, { label }, { default: control });

const App = {
  render() {
    return h(ElForm, { labelPosition: 'top', style: 'max-width:560px;margin:24px', onSubmit: (e: Event) => e.preventDefault() }, {
      default: () => [
        item('姓名', () => h(ElInput, { modelValue: model.name, 'onUpdate:modelValue': (v: string) => (model.name = v) })),
        item('邮箱', () => h(ElInput, { modelValue: model.email, 'onUpdate:modelValue': (v: string) => (model.email = v) })),
        item('性别', () => h(ElRadioGroup, { modelValue: model.gender, 'onUpdate:modelValue': (v: string) => (model.gender = v) }, {
          default: () => ['男', '女'].map((label) => h(ElRadio, { value: label, label })),
        })),
        item('工作城市', () => h(ElSelect, { modelValue: model.city, placeholder: '请选择', 'onUpdate:modelValue': (v: string) => (model.city = v) }, {
          default: () => ['北京', '上海', '深圳'].map((v) => h(ElOption, { value: v, label: v })),
        })),
        item('最高学历', () => h(ElSelect, { modelValue: model.degree, filterable: true, placeholder: '可搜索', 'onUpdate:modelValue': (v: string) => (model.degree = v) }, {
          default: () => ['本科', '硕士', '博士'].map((v) => h(ElOption, { value: v, label: v })),
        })),
        item('所在地区', () => h(ElCascader, { modelValue: model.region, options: REGIONS, placeholder: '请选择', 'onUpdate:modelValue': (v: string[]) => (model.region = v) })),
        item('入职日期', () => h(ElDatePicker, { modelValue: model.joined, type: 'date', valueFormat: 'YYYY-MM-DD', placeholder: '选择日期', 'onUpdate:modelValue': (v: string) => (model.joined = v) })),
        item('工作年限', () => h(ElInputNumber, { modelValue: model.years, 'onUpdate:modelValue': (v: number) => (model.years = v) })),
        item('编程语言', () => h(ElCheckboxGroup, { modelValue: model.skills, 'onUpdate:modelValue': (v: string[]) => (model.skills = v) }, {
          default: () => ['JavaScript', 'Python', 'Go', 'Rust'].map((v) => h(ElCheckbox, { value: v, label: v })),
        })),
        item('', () => h(ElButton, { type: 'primary', nativeType: 'submit', onClick: () => { (window as any).__submitted = true; } }, { default: () => '提交' })),
      ],
    });
  },
};

(window as any).__values = {};
(window as any).__submitted = false;
createApp(App).mount('#root');
